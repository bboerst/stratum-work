/**
 * Live stream de-duplication across a pool's collector replicas (#178). With several collectors per pool, each one
 * publishes every template it receives, so the stream would deliver each template once per collector. The rule is
 * the one the history reads follow (templates_dedup, #177):
 *
 * * Only EXACT copies are hidden: same pool (pool_name), height, prev_hash, merkle_branches, version, nbits and
 *   ntime. No time or ntime tolerance; a template that differs in any of these fields is always forwarded (a near
 *   miss), and so is a template only one collector received (a gap fill). Per-connection fields (job_id,
 *   extranonce1, coinbase, latency, timestamp) may differ between copies.
 * * Copies are paired one-to-one per source (site + replica): the n-th time a source sends a key is a copy if some
 *   other source has already sent that key n times. So a source's own re-sends of an identical template are
 *   forwarded, exactly as with one collector, and a stream with one source per pool is never filtered.
 * * A stream can't know which collector is the pool's primary (arrival order differs), so the first copy to arrive
 *   is the one forwarded: still one row per template. Per-site first-seen belongs to the history views.
 * * Templates without `site` and `replica` (older collectors, MongoDB mode) are never filtered, so a deployment with
 *   one collector per pool behaves as before.
 *
 * Memory is bounded per stream connection: per pool, keys of at most `maxHeights` heights (the least recently seen
 * height is forgotten when a new one appears; pools that mine other chains on the same port alternate between
 * heights, so this is a small window rather than "current height only") and at most `maxKeysPerPool` keys (oldest
 * first); at most `maxPools` pools (least recently seen first). Forgetting a key can only show a late copy twice,
 * never hide a template.
 */

import { createHash } from "crypto";

export interface StreamDedupOptions {
  /** Distinct heights remembered per pool. */
  maxHeights: number;
  /** Template keys remembered per pool, over all its heights. */
  maxKeysPerPool: number;
  /** Pools remembered. */
  maxPools: number;
}

export const DEFAULT_STREAM_DEDUP: StreamDedupOptions = { maxHeights: 3, maxKeysPerPool: 256, maxPools: 256 };

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
  /** Times each source (site + replica) has sent this key. */
  counts: Map<string, number>;
  /** max(counts): how many times the key has been forwarded. */
  forwarded: number;
}

interface PoolState {
  /** height -> key -> state; both in recency order (oldest first). */
  heights: Map<number, Map<string, KeyState>>;
  keys: number;
}

export class StreamTemplateDedup {
  private readonly opts: StreamDedupOptions;
  private readonly pools = new Map<string, PoolState>();
  /** Templates dropped as exact copies, for logging and tests. */
  dropped = 0;

  constructor(opts: Partial<StreamDedupOptions> = {}) {
    this.opts = { ...DEFAULT_STREAM_DEDUP, ...opts };
  }

  /** True if the template should be forwarded, false if it is an exact copy another source already sent. */
  accept(t: StreamTemplateFields): boolean {
    if (typeof t.site !== "string" || typeof t.replica !== "string" || typeof t.pool_name !== "string") return true;
    if (typeof t.height !== "number" || !Number.isFinite(t.height)) return true;
    if (t.prev_hash === undefined || t.merkle_branches === undefined || t.version === undefined
      || t.nbits === undefined || t.ntime === undefined) return true;
    // Exact, unambiguous key: the values as published (strings, the branch list in order), stored as its SHA-256
    // (32 bytes instead of ~1 KB with a dozen branches; a collision is computationally infeasible, so this is still
    // an exact match).
    const key = createHash("sha256")
      .update(JSON.stringify([t.prev_hash, t.merkle_branches, t.version, t.nbits, t.ntime]))
      .digest("base64");
    const source = JSON.stringify([t.site, t.replica]);

    const pool = this.pool(t.pool_name);
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

  private pool(name: string): PoolState {
    let p = this.pools.get(name);
    if (p === undefined) {
      p = { heights: new Map(), keys: 0 };
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
