/**
 * Live stream, `?connections=all` (#321): the work of a pool's other connections that the one-stream-per-pool rule
 * (lib/streamDedup.ts) hides. Decided once in the hub for every viewer, on its own bounded state: the dedup's state
 * machine is left alone (its `accept()` returning false can't tell a copy from another job, and it keeps keys only for
 * forwarded templates).
 *
 * The rule, per pool, on the exact key (height, pool, prev_hash, merkle_branches, version, nbits, ntime; ntime
 * included, no tolerance; lib/streamDedup.ts templateKey):
 *
 * * A hidden template (another connection's stream, or an exact copy) is judged `holdMs` after it arrived (10 s,
 *   template_stream_lead()). If no other connection of the pool received a template with the same key within
 *   ±holdMs of it, it is that connection's distinct work: a `template` event.
 * * When a connection whose last judged template was distinct receives an exact copy of another connection's
 *   template again (within ±holdMs), or its template is now the one the pool's stream shows (its lower-ranked
 *   connections fell silent), a `copy` event says its distinct work has ended.
 *
 * Why wait: a pool's connections get the same template in no fixed order, seconds apart in the tails, so a template
 * can only be called distinct once the other connections had the same moment to receive it. Arrival time at the web
 * server is used, as in the dedup.
 *
 * After `reset()` (the hub's consumer (re)started), templates received in the first holdMs aren't judged: their
 * copies may have arrived before the consumer was listening.
 *
 * Memory is bounded: per pool at most `maxEntriesPerPool` received templates (kept for 2 × holdMs, oldest dropped
 * first), `maxPendingPerPool` templates waiting to be judged (oldest dropped unjudged) and `maxSourcesPerPool`
 * connection states; at most `maxPools` pools (least recently seen dropped). Forgetting a received template can only
 * call a copy distinct; dropping a pending one only skips its event.
 */
import { templateKey, type StreamTemplateFields } from './streamDedup';

/** The pool's connections receive the same template within this of each other (template_stream_lead()). */
export const STREAM_LEAD_MS = 10_000;

export interface StreamConnectionsOptions {
  holdMs: number;
  maxPools: number;
  maxEntriesPerPool: number;
  maxPendingPerPool: number;
  maxSourcesPerPool: number;
}

export const DEFAULT_STREAM_CONNECTIONS: StreamConnectionsOptions = {
  holdMs: STREAM_LEAD_MS, maxPools: 256, maxEntriesPerPool: 4096, maxPendingPerPool: 1024, maxSourcesPerPool: 16,
};

export interface ConnectionEvent {
  /** template: a connection's distinct work (data is the message as viewers get it); copy: its distinct work ended. */
  kind: 'template' | 'copy';
  pool: string;
  site: string;
  replica: string;
  height: number;
  /** When the template the event is about arrived (ms). */
  at: number;
  data?: string;
}

interface Entry { at: number; source: string; hk: string }

interface Pending {
  at: number;
  source: string;
  site: string;
  replica: string;
  height: number;
  hk: string;
  /** Forwarded in the pool's shown stream (never distinct work: it is shown already). */
  shown: boolean;
  data: string;
}

interface PoolState {
  /** Received templates, oldest first (entries[head..] are live). */
  entries: Entry[];
  head: number;
  /** height + key -> its entries, oldest first. */
  index: Map<string, Entry[]>;
  pending: Pending[];
  pendingHead: number;
  /** source -> its last judged template was distinct work; in recency order. */
  distinct: Map<string, boolean>;
}

export class StreamConnections {
  private readonly opts: StreamConnectionsOptions;
  private readonly pools = new Map<string, PoolState>();
  private startedAt = -Infinity;
  /** Pending templates dropped unjudged (over maxPendingPerPool), for logs and tests. */
  droppedPending = 0;

  constructor(opts: Partial<StreamConnectionsOptions> = {}) {
    this.opts = { ...DEFAULT_STREAM_CONNECTIONS, ...opts };
  }

  /** Forget everything; templates received before `now + holdMs` aren't judged. */
  reset(now: number): void {
    this.pools.clear();
    this.startedAt = now;
  }

  /**
   * Records a template as it arrives. `shown`: the dedup forwarded it in the pool's stream. Templates without site,
   * replica or the key fields are ignored (they are never filtered either).
   */
  observe(t: StreamTemplateFields, data: string, shown: boolean, now: number): void {
    if (typeof t.site !== 'string' || typeof t.replica !== 'string' || typeof t.pool_name !== 'string') return;
    if (typeof t.height !== 'number' || !Number.isFinite(t.height)) return;
    if (t.prev_hash === undefined || t.merkle_branches === undefined || t.version === undefined
      || t.nbits === undefined || t.ntime === undefined) return;
    const pool = this.pool(t.pool_name);
    const source = JSON.stringify([t.site, t.replica]);
    const hk = `${t.height}\0${templateKey(t)}`;
    const e: Entry = { at: now, source, hk };
    pool.entries.push(e);
    let list = pool.index.get(hk);
    if (list === undefined) pool.index.set(hk, (list = []));
    list.push(e);
    while (pool.entries.length - pool.head > this.opts.maxEntriesPerPool) this.dropEntry(pool);
    if (now < this.startedAt + this.opts.holdMs) return;
    pool.pending.push({ at: now, source, site: t.site, replica: t.replica, height: t.height, hk, shown, data });
    while (pool.pending.length - pool.pendingHead > this.opts.maxPendingPerPool) {
      pool.pendingHead += 1;
      this.droppedPending += 1;
    }
    compact(pool);
  }

  /** Judges the templates whose hold has passed; events in arrival order. */
  tick(now: number): ConnectionEvent[] {
    const out: ConnectionEvent[] = [];
    const hold = this.opts.holdMs;
    for (const [name, pool] of this.pools) {
      while (pool.pendingHead < pool.pending.length && pool.pending[pool.pendingHead].at + hold <= now) {
        const p = pool.pending[pool.pendingHead++];
        const was = pool.distinct.get(p.source) === true;
        let distinct = false;
        if (!p.shown) {
          const same = pool.index.get(p.hk);
          distinct = !same?.some(e => e.source !== p.source && Math.abs(e.at - p.at) <= hold);
        }
        if (distinct) {
          out.push({ kind: 'template', pool: name, site: p.site, replica: p.replica, height: p.height, at: p.at, data: p.data });
        } else if (was) {
          out.push({ kind: 'copy', pool: name, site: p.site, replica: p.replica, height: p.height, at: p.at });
        }
        this.setDistinct(pool, p.source, distinct);
      }
      // Keep received templates while a pending one may still look back at them, and at least 2 × hold.
      const oldestPending = pool.pendingHead < pool.pending.length ? pool.pending[pool.pendingHead].at : Infinity;
      const keepFrom = Math.min(now - 2 * hold, oldestPending - hold);
      while (pool.head < pool.entries.length && pool.entries[pool.head].at < keepFrom) this.dropEntry(pool);
      compact(pool);
      if (pool.head === pool.entries.length && pool.pendingHead === pool.pending.length
        && ![...pool.distinct.values()].some(Boolean)) {
        this.pools.delete(name);
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /** Remembered received templates over all pools (tests, bounds checks). */
  size(): number {
    let n = 0;
    for (const p of this.pools.values()) n += p.entries.length - p.head;
    return n;
  }

  pendingCount(): number {
    let n = 0;
    for (const p of this.pools.values()) n += p.pending.length - p.pendingHead;
    return n;
  }

  poolCount(): number {
    return this.pools.size;
  }

  private setDistinct(pool: PoolState, source: string, distinct: boolean): void {
    pool.distinct.delete(source);
    if (pool.distinct.size >= this.opts.maxSourcesPerPool) {
      const oldest = pool.distinct.keys().next().value;
      if (oldest !== undefined) pool.distinct.delete(oldest);
    }
    pool.distinct.set(source, distinct);
  }

  private dropEntry(pool: PoolState): void {
    const e = pool.entries[pool.head++];
    const list = pool.index.get(e.hk);
    if (list === undefined) return;
    // Entries leave in arrival order, so e is the first of its list.
    if (list[0] === e) list.shift();
    else list.splice(list.indexOf(e), 1);
    if (list.length === 0) pool.index.delete(e.hk);
  }

  private pool(name: string): PoolState {
    let p = this.pools.get(name);
    if (p === undefined) {
      p = { entries: [], head: 0, index: new Map(), pending: [], pendingHead: 0, distinct: new Map() };
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
}

/** Drops consumed array heads once they are half the array (amortised O(1)). */
function compact(pool: PoolState): void {
  if (pool.head > 64 && pool.head * 2 > pool.entries.length) {
    pool.entries = pool.entries.slice(pool.head);
    pool.head = 0;
  }
  if (pool.pendingHead > 64 && pool.pendingHead * 2 > pool.pending.length) {
    pool.pending = pool.pending.slice(pool.pendingHead);
    pool.pendingHead = 0;
  }
}
