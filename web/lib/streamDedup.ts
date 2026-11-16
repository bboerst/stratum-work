/**
 * Live stream: one stream per pool across its collector replicas. With several collectors per pool each one
 * publishes every template it receives, and some pools give each connection its own jobs (other merkle branches,
 * or the same job with another ntime), so forwarding everything would show such a pool about twice. The rule is the
 * one the history reads follow (templates_copies / templates_dedup,
 * db/migrations/20261116100001_one_stream_per_pool.sql), applied as messages arrive:
 *
 * * Sources (site + replica) of a pool are ranked by (site, replica), compared by UTF-16 code units (the views
 *   compare with COLLATE "C"; the same order for ASCII names).
 * * A template is forwarded only if its source is the lowest-ranked ACTIVE source of the pool: no lower-ranked
 *   source sent a template in the last `silenceMs` (90 s, the views' template_stream_silence()). So normally only
 *   the primary's stream is shown; when it falls silent for longer than that (collector down, connection lost) the
 *   next source's templates are shown, and as soon as the primary sends again the stream switches back.
 * * Among forwarded templates, exact copies are still dropped (#178): same pool, height, prev_hash,
 *   merkle_branches, version, nbits and ntime, paired one-to-one per source, so a source's own identical re-sends
 *   are forwarded and a template the next source already forwarded at the switch-over isn't shown twice.
 * * Templates without `site` and `replica` (older collectors, MongoDB mode) are never filtered, so a deployment with
 *   one collector per pool behaves as before; a stream with one source per pool is never filtered either.
 *
 * Differences from the history views, which see the whole height: the stream can't look ahead, so it shows a
 * secondary's templates up to the primary's return (the views hide those within template_stream_lead() = 10 s
 * before it), and it judges activity across heights (the views per height, with the 10 s lead covering the
 * new-block moment). Arrival time at the web server is used, not the collectors' clocks.
 *
 * Memory is bounded per stream connection: per pool, the sources' last-seen times (at most `maxSourcesPerPool`) and
 * exact-copy keys of at most `maxHeights` heights (the least recently seen height is forgotten when a new one
 * appears; pools that mine other chains on the same port alternate between heights) and at most `maxKeysPerPool`
 * keys (oldest first); at most `maxPools` pools (least recently seen first). Forgetting a key can only show a late
 * copy twice; forgetting a source can only treat it as silent.
 */

import { createHash } from "crypto";

/** How long a lower-ranked source must be silent before the next one's templates are shown (template_stream_silence()). */
export const STREAM_SILENCE_MS = 90_000;

export interface StreamDedupOptions {
  /** Distinct heights remembered per pool. */
  maxHeights: number;
  /** Template keys remembered per pool, over all its heights. */
  maxKeysPerPool: number;
  /** Pools remembered. */
  maxPools: number;
  /** Sources (site + replica) remembered per pool. */
  maxSourcesPerPool: number;
  /** A source is active while its last template is at most this old. */
  silenceMs: number;
}

export const DEFAULT_STREAM_DEDUP: StreamDedupOptions = {
  maxHeights: 3, maxKeysPerPool: 256, maxPools: 256, maxSourcesPerPool: 16, silenceMs: STREAM_SILENCE_MS,
};

/** The template fields the stream route reads (as published by the collectors). */
export interface StreamTemplateFields {
  pool_name?: unknown;
  height?: unknown;
  prev_hash?: unknown;
  merkle_branches?: unknown;
  version?: unknown;
  nbits?: unknown;
  ntime?: unknown;
  site?: unknown;
  replica?: unknown;
}

interface KeyState {
  /** Times each source (site + replica) has had this key forwarded. */
  counts: Map<string, number>;
  /** max(counts): how many times the key has been forwarded. */
  forwarded: number;
}

interface SourceState {
  site: string;
  replica: string;
  lastSeen: number;
}

interface PoolState {
  /** height -> key -> state; both in recency order (oldest first). */
  heights: Map<number, Map<string, KeyState>>;
  keys: number;
  /** source id -> state, in recency order (oldest first). */
  sources: Map<string, SourceState>;
}

/** (site, replica) order: negative if a ranks before b. */
function compareSource(aSite: string, aReplica: string, bSite: string, bReplica: string): number {
  if (aSite !== bSite) return aSite < bSite ? -1 : 1;
  if (aReplica !== bReplica) return aReplica < bReplica ? -1 : 1;
  return 0;
}

export class StreamTemplateDedup {
  private readonly opts: StreamDedupOptions;
  private readonly pools = new Map<string, PoolState>();
  /** Templates dropped as exact copies, for logging and tests. */
  dropped = 0;
  /** Templates dropped because a lower-ranked source of the pool was active (another connection's stream). */
  droppedSecondary = 0;

  constructor(opts: Partial<StreamDedupOptions> = {}) {
    this.opts = { ...DEFAULT_STREAM_DEDUP, ...opts };
  }

  /**
   * True if the template should be forwarded; false if another, lower-ranked source of the pool is active or it is
   * an exact copy of a template already forwarded. `now` is the arrival time in ms.
   */
  accept(t: StreamTemplateFields, now: number = Date.now()): boolean {
    if (typeof t.site !== "string" || typeof t.replica !== "string" || typeof t.pool_name !== "string") return true;
    if (typeof t.height !== "number" || !Number.isFinite(t.height)) return true;
    if (t.prev_hash === undefined || t.merkle_branches === undefined || t.version === undefined
      || t.nbits === undefined || t.ntime === undefined) return true;
    const source = JSON.stringify([t.site, t.replica]);
    const pool = this.pool(t.pool_name);

    // One stream per pool: is a lower-ranked source active?
    const lower = this.lowerActive(pool, t.site, t.replica, now);
    this.seen(pool, source, t.site, t.replica, now);
    if (lower) {
      this.droppedSecondary += 1;
      return false;
    }

    // Exact copies among forwarded templates. Exact, unambiguous key: the values as published (strings, the branch
    // list in order), stored as its SHA-256 (32 bytes instead of ~1 KB with a dozen branches; a collision is
    // computationally infeasible, so this is still an exact match).
    const key = createHash("sha256")
      .update(JSON.stringify([t.prev_hash, t.merkle_branches, t.version, t.nbits, t.ntime]))
      .digest("base64");
    const keys = this.height(pool, t.height);
    let s = keys.get(key);
    if (s === undefined) {
      s = { counts: new Map(), forwarded: 0 };
      keys.set(key, s);
      pool.keys += 1;
      this.trim(pool);
    } else {
      keys.delete(key); // move to most recent
      keys.set(key, s);
    }
    const n = (s.counts.get(source) ?? 0) + 1;
    s.counts.set(source, n);
    if (n > s.forwarded) {
      s.forwarded = n;
      return true;
    }
    this.dropped += 1;
    return false;
  }

  /** Remembered keys over all pools (for tests and bounds checks). */
  size(): number {
    let n = 0;
    for (const p of this.pools.values()) n += p.keys;
    return n;
  }

  poolCount(): number {
    return this.pools.size;
  }

  /** Remembered sources over all pools (for tests and bounds checks). */
  sourceCount(): number {
    let n = 0;
    for (const p of this.pools.values()) n += p.sources.size;
    return n;
  }

  private lowerActive(pool: PoolState, site: string, replica: string, now: number): boolean {
    for (const s of pool.sources.values()) {
      if (now - s.lastSeen <= this.opts.silenceMs && compareSource(s.site, s.replica, site, replica) < 0) return true;
    }
    return false;
  }

  private seen(pool: PoolState, id: string, site: string, replica: string, now: number): void {
    const s = pool.sources.get(id);
    if (s !== undefined) {
      pool.sources.delete(id); // move to most recent
      s.lastSeen = Math.max(s.lastSeen, now);
      pool.sources.set(id, s);
      return;
    }
    if (pool.sources.size >= this.opts.maxSourcesPerPool) {
      const oldest = pool.sources.keys().next().value;
      if (oldest !== undefined) pool.sources.delete(oldest);
    }
    pool.sources.set(id, { site, replica, lastSeen: now });
  }

  private pool(name: string): PoolState {
    let p = this.pools.get(name);
    if (p === undefined) {
      p = { heights: new Map(), keys: 0, sources: new Map() };
      if (this.pools.size >= this.opts.maxPools) {
        const oldest = this.pools.keys().next().value;
        if (oldest !== undefined) this.pools.delete(oldest);
      }
    } else {
      this.pools.delete(name);
    }
    this.pools.set(name, p);
    return p;
  }

  private height(pool: PoolState, height: number): Map<string, KeyState> {
    let keys = pool.heights.get(height);
    if (keys === undefined) {
      keys = new Map();
      if (pool.heights.size >= this.opts.maxHeights) {
        const [oldest, oldKeys] = pool.heights.entries().next().value as [number, Map<string, KeyState>];
        pool.keys -= oldKeys.size;
        pool.heights.delete(oldest);
      }
    } else {
      pool.heights.delete(height);
    }
    pool.heights.set(height, keys);
    return keys;
  }

  /** Drop the oldest keys (least recently seen height first) while the pool is over its key limit. */
  private trim(pool: PoolState): void {
    while (pool.keys > this.opts.maxKeysPerPool) {
      const first = pool.heights.entries().next().value as [number, Map<string, KeyState>] | undefined;
      if (first === undefined) return;
      const [h, keys] = first;
      const k = keys.keys().next().value;
      if (k === undefined) {
        pool.heights.delete(h);
        continue;
      }
      keys.delete(k);
      pool.keys -= 1;
      if (keys.size === 0) pool.heights.delete(h);
    }
  }
}
