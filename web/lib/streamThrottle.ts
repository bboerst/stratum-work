/**
 * Per-pool rate limit for the realtime stream (#105). A pool's job server can send thousands of templates in a
 * second; forwarding each one to every browser would freeze the page. Normal traffic (a template every few
 * seconds, a handful at a new block) passes untouched. Over the rate, only the newest template is held and sent as
 * soon as the pool is under the rate again, so the display stays current, and a `burst` marker says how many
 * weren't shown. This only affects the live display: every template is still stored by the collector.
 *
 * Markers carry `pool_name`, so the stream route's pool blacklist applies to them too (it filters before this).
 *
 * `?connections=all` (#321) gives another connection's messages their own state, keyed per pool + connection (the
 * `connection` argument), so they don't use up the pool's rate; their markers are `connection_burst` with the
 * connection's letter, so views that read `burst` as a gap in the pool's stream don't see them.
 */

export interface PoolThrottleOptions {
  /** Templates per second forwarded per pool, on average. 0 disables the throttle. */
  ratePerSecond: number;
  /** Templates a pool may send at once before the rate applies. */
  burst: number;
  /** Markers are sent at most this often per pool during a long burst. */
  markerIntervalMs?: number;
}

export interface BurstMarker {
  type: "burst";
  pool_name: string;
  /** Templates from this pool not forwarded live since the previous marker. */
  suppressed: number;
  /** Receive times (server clock, ms since the epoch) of the first and last suppressed template. */
  first_ms: number;
  last_ms: number;
}

/** A burst on another connection of the pool (`?connections=all`). */
export interface ConnectionBurstMarker extends Omit<BurstMarker, "type"> {
  type: "connection_burst";
  connection: string;
}

export const DEFAULT_POOL_THROTTLE: PoolThrottleOptions = { ratePerSecond: 5, burst: 20, markerIntervalMs: 1000 };

/** Idle pool state is forgotten after this long (bounds memory per connection). */
const IDLE_FORGET_MS = 60_000;

interface PoolState {
  pool: string;
  connection?: string;
  tokens: number;
  refilledAt: number;
  pending: string | null;
  unreported: number;
  firstMs: number;
  lastMs: number;
  lastMarker: number;
  lastSeen: number;
}

export class PoolStreamThrottle {
  private readonly opts: Required<PoolThrottleOptions>;
  private readonly pools = new Map<string, PoolState>();

  constructor(opts: Partial<PoolThrottleOptions> = {}) {
    this.opts = { ...DEFAULT_POOL_THROTTLE, markerIntervalMs: 1000, ...opts } as Required<PoolThrottleOptions>;
  }

  get enabled(): boolean {
    return this.opts.ratePerSecond > 0;
  }

  /**
   * Messages to forward now for a template from `pool` (possibly none: it's held as the newest). `connection`: a
   * message of that connection of the pool (`?connections=all`), with its own rate.
   */
  offer(pool: string, message: string, now: number, connection?: string): string[] {
    if (!this.enabled) return [message];
    const s = this.state(pool, now, connection);
    s.lastSeen = now;
    this.refill(s, now);
    if (s.pending === null && s.tokens >= 1) {
      s.tokens -= 1;
      return [message];
    }
    if (s.pending !== null) {
      s.unreported += 1; // the held template is replaced by a newer one and never shown
    }
    if (s.unreported === 0 && s.pending === null) s.firstMs = now;
    s.pending = message;
    s.lastMs = now;
    return [];
  }

  /** Called periodically: forwards held templates whose pool is under the rate again, with burst markers. */
  tick(now: number): string[] {
    if (!this.enabled) return [];
    const out: string[] = [];
    for (const [key, s] of this.pools) {
      this.refill(s, now);
      if (s.pending !== null && s.tokens >= 1) {
        s.tokens -= 1;
        const latest = s.pending;
        s.pending = null;
        // Templates were skipped before this one: the marker always goes first, so the browser knows this template
        // doesn't follow the last one it got (change detection doesn't compare across the gap). At most one marker
        // per forwarded template, so still bounded by the rate.
        if (s.unreported > 0) out.push(this.marker(s, now));
        out.push(latest);
      } else if (s.pending === null && s.unreported > 0 && now - s.lastMarker >= this.opts.markerIntervalMs) {
        out.push(this.marker(s, now)); // the burst is over: report what's left
      }
      if (s.pending === null && s.unreported === 0 && now - s.lastSeen > IDLE_FORGET_MS) this.pools.delete(key);
    }
    return out;
  }

  private marker(s: PoolState, now: number): string {
    const m: BurstMarker | ConnectionBurstMarker = s.connection === undefined
      ? { type: "burst", pool_name: s.pool, suppressed: s.unreported, first_ms: s.firstMs, last_ms: s.lastMs }
      : { type: "connection_burst", pool_name: s.pool, connection: s.connection, suppressed: s.unreported,
        first_ms: s.firstMs, last_ms: s.lastMs };
    s.unreported = 0;
    s.lastMarker = now;
    s.firstMs = now;
    return JSON.stringify(m);
  }

  private state(pool: string, now: number, connection?: string): PoolState {
    const key = connection === undefined ? pool : `${pool}\0${connection}`;
    let s = this.pools.get(key);
    if (!s) {
      s = { pool, connection, tokens: this.opts.burst, refilledAt: now, pending: null, unreported: 0, firstMs: now, lastMs: now,
        lastMarker: 0, lastSeen: now };
      this.pools.set(key, s);
    }
    return s;
  }

  private refill(s: PoolState, now: number): void {
    const elapsed = Math.max(0, now - s.refilledAt);
    s.tokens = Math.min(this.opts.burst, s.tokens + (elapsed / 1000) * this.opts.ratePerSecond);
    s.refilledAt = now;
  }
}

/** Throttle options from the environment: STREAM_POOL_RATE (per second, 0 = off) and STREAM_POOL_BURST. */
export function poolThrottleFromEnv(env: Record<string, string | undefined> = process.env): PoolThrottleOptions {
  const num = (v: string | undefined, def: number) => {
    const n = v === undefined || v === "" ? NaN : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : def;
  };
  return {
    ratePerSecond: num(env.STREAM_POOL_RATE, DEFAULT_POOL_THROTTLE.ratePerSecond),
    burst: Math.max(1, num(env.STREAM_POOL_BURST, DEFAULT_POOL_THROTTLE.burst)),
    markerIntervalMs: DEFAULT_POOL_THROTTLE.markerIntervalMs,
  };
}
