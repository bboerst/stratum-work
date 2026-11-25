/**
 * Shared, bounded buffer of recent Stratum templates for the realtime visuals (#130).
 *
 * The buffer lives above the visuals (in DataStreamProvider), so switching between the table, timing chart and
 * Sankey keeps everything collected so far. It's seeded once from history (/api/realtime-prefill) and then fed by
 * /api/stream. The two overlap, so entries are de-duplicated on templateKey().
 *
 * Pure TypeScript, no React: unit-tested in lib/__tests__/templateBuffer.test.ts.
 */
import type { StratumV1Data } from './types';

export interface BufferedTemplate {
  key: string;
  /** Insertion order, strictly increasing. Incremental consumers process entries with seq > the last one they saw. */
  seq: number;
  /** Collector receive time, ms since the epoch (from the hex-nanosecond `timestamp`). */
  timeMs: number;
  /** This row's own receive time (`received_timestamp ?? timestamp`), ms: the order change detection compares in. */
  recvMs: number;
  data: StratumV1Data;
  /**
   * Nothing proves this template and the pool's one before it (in `recvMs` order) were consecutive: templates may have
   * been missed in between, so change detection doesn't compare them. Cleared when a later history read covers both.
   */
  gapBefore?: boolean;
  /** Came from the live stream (else from a history read). */
  live?: boolean;
  /**
   * The continuous observations that saw this template: a live run (`l<n>.<m>`: the stream between two gaps) or one
   * history response (`h<n>`). Two neighbours that share one are consecutive; see TemplateBuffer.
   */
  segs: string[];
  /**
   * A template of the pool between this one and the one before it is gone from the buffer (trimmed below the kept
   * heights) or was never added (below them): no observation can prove the two consecutive any more.
   */
  cut?: boolean;
}

export interface TemplateBufferLimits {
  /** Heights kept, ending at the current height (3 = the height being mined and the two before it). */
  heights: number;
  /** Hard cap on rows; the oldest (by receive time) go first. */
  maxRows: number;
}

export const DEFAULT_TEMPLATE_BUFFER_LIMITS: TemplateBufferLimits = { heights: 3, maxRows: 5000 };

/**
 * Templates more than this many heights above the Bitcoin tip can't be work on the next block, so they're dropped
 * (an unclassified other-chain template must not drag the window away from Bitcoin). Tip + 2 leaves room for a
 * block our backend hasn't seen yet.
 */
const MAX_HEIGHTS_ABOVE_TIP = 2;

const HEX_RE = /^(0[xX])?[0-9a-fA-F]+$/;

/**
 * The collector's hex-nanosecond `timestamp` → whole microseconds. Postgres stores µs, so the API returns the same
 * receive time with the last three nanosecond digits zeroed; comparing at µs makes both forms equal.
 */
export function timestampMicros(timestamp: string | undefined | null): bigint | null {
  if (!timestamp || !HEX_RE.test(timestamp)) return null;
  const hex = timestamp.startsWith('0x') || timestamp.startsWith('0X') ? timestamp.slice(2) : timestamp;
  try {
    return BigInt('0x' + hex) / BigInt(1000);
  } catch {
    return null;
  }
}

/**
 * De-duplication key: pool + own receive time in µs + the template's content (ntime, coinbase1, coinbase2).
 *
 * It's the same for a template whether it came from the stream or the API (the API's id, `<source>-<µs>-<hash>`,
 * isn't in the stream). Pool + µs alone is NOT unique: the collector stamps every notification from one socket read
 * with the same receive time, so one pool can send two templates in the same µs (3 of 16,310 on dev data,
 * 2026-11-12, always with different ntime/coinbase). Hex is lower-cased because Postgres returns lower-case and the
 * stream keeps the pool's casing.
 */
export function templateKey(
  t: Pick<StratumV1Data, 'pool_name' | 'timestamp'> & Partial<Pick<StratumV1Data, 'received_timestamp' | 'ntime' | 'coinbase1' | 'coinbase2'>>,
): string | null {
  // The row's own receive time: a history read's `timestamp` can be the first-seen time over other connections' copies,
  // while the live stream sends the shown connection's own, so keying on `timestamp` would buffer one template twice.
  const us = timestampMicros(t.received_timestamp ?? t.timestamp);
  if (us === null || !t.pool_name) return null;
  const content = [t.ntime, t.coinbase1, t.coinbase2].map(v => (v ?? '').toLowerCase()).join('|');
  return `${t.pool_name}|${us.toString()}|${content}`;
}

function compareEntries(a: BufferedTemplate, b: BufferedTemplate): number {
  return a.timeMs - b.timeMs || a.seq - b.seq;
}

/** Receive order (the order change detection compares in): own receive time, then insertion order. */
function compareReceived(a: BufferedTemplate, b: BufferedTemplate): number {
  return a.recvMs - b.recvMs || a.seq - b.seq;
}

const shareSeg = (a: BufferedTemplate, b: BufferedTemplate) => a.segs.some(s => b.segs.includes(s));
/** Whether `b` follows `a` (the pool's one before it) in one observation, with nothing of the pool left out between. */
const linked = (a: BufferedTemplate, b: BufferedTemplate) => !b.cut && shareSeg(a, b);

export class TemplateBuffer {
  private readonly limits: TemplateBufferLimits;
  private readonly byKey = new Map<string, BufferedTemplate>();
  private nextSeq = 1;
  private tip: number | null = null;
  private maxTemplateHeight: number | null = null;
  private snapshot: BufferedTemplate[] | null = null;
  /**
   * Which neighbours change detection may compare. Two templates of a pool that are neighbours in receive order are
   * consecutive only when one continuous observation saw both: one run of the live stream (a pool's stream between
   * two gaps, markGap), or one history response (a fresh read of the pool's recent templates; the collector writes
   * each connection's templates in receive order, so a read that has a template has every one before it). Anything
   * else (the pre-fill/stream seam, a pause, a reconnect, a throttled burst) leaves `gapBefore` set until a later
   * history read covers both sides.
   */
  private liveRunAll = 0;
  private readonly liveRunByPool = new Map<string, number>();
  private responses = 0;
  /** Each pool's entries in receive order. */
  private readonly byPool = new Map<string, BufferedTemplate[]>();
  /** Bumped whenever an entry gets `gapBefore`: a history read may now fill it in. */
  gapVersion = 0;

  /** Bumped on every change. */
  version = 0;
  /**
   * Bumped when an entry arrives out of order (older than something already buffered for that pool), e.g. the
   * pre-fill landing after the first live messages. Incremental consumers rebuild from entries() when it changes.
   */
  epoch = 0;

  constructor(limits: Partial<TemplateBufferLimits> = {}) {
    this.limits = { ...DEFAULT_TEMPLATE_BUFFER_LIMITS, ...limits };
  }

  get size(): number {
    return this.byKey.size;
  }

  get tipHeight(): number | null {
    return this.tip;
  }

  /** The height being mined: tip + 1, or the highest buffered template height if that's higher (or there's no tip). */
  get currentHeight(): number | null {
    const fromTip = this.tip === null ? null : this.tip + 1;
    if (fromTip === null) return this.maxTemplateHeight;
    if (this.maxTemplateHeight === null) return fromTip;
    return Math.max(fromTip, this.maxTemplateHeight);
  }

  /** Record the Bitcoin tip (highest block). Only moves forward: a re-indexed old block doesn't move it back. */
  setTip(height: number | null | undefined): boolean {
    if (height === null || height === undefined || !Number.isInteger(height) || height < 0) return false;
    if (this.tip !== null && height <= this.tip) return false;
    this.tip = height;
    if (this.maxTemplateHeight !== null && this.maxTemplateHeight > height + MAX_HEIGHTS_ABOVE_TIP) {
      // Drop anything the new tip shows can't be Bitcoin work.
      for (const [key, entry] of this.byKey) {
        if (entry.data.height > height + MAX_HEIGHTS_ABOVE_TIP) this.byKey.delete(key);
      }
      this.dropRemovedFromPools();
      this.recomputeMaxHeight();
    }
    this.trim();
    this.changed();
    return true;
  }

  /**
   * Merge templates (the history pre-fill, or the live stream with `live`). Returns how many new entries were added. A template
   * already buffered is not added again. Non-Bitcoin templates and pools rejected by `isAllowed` are skipped.
   */
  add(
    templates: StratumV1Data[],
    isAllowed: (poolName: string) => boolean = () => true,
    { live = false }: { live?: boolean } = {},
  ): number {
    let added = 0;
    let outOfOrder = false;
    const firstSeq = this.nextSeq;
    const newestByPool = this.newestByPool();
    // One history response is one observation; each live template belongs to its pool's current run.
    const responseSeg = live ? null : `h${++this.responses}`;
    const recompute = new Set<string>();
    // Rows of this response below the kept heights are left out, so the response's other rows of that pool aren't one
    // contiguous stretch across them: each such row splits the pool's rows into separate observations.
    const skippedByPool = responseSeg === null ? null : this.belowFloorByPool(templates, isAllowed);

    for (const data of templates) {
      // Other chains' templates arrive untagged (collectors don't classify, docs/design/one-templates-table.md): the
      // height bounds keep them out: at most MAX_HEIGHTS_ABOVE_TIP above the Bitcoin tip, and not below the kept
      // height range. One with a far height that arrives before the first tip is pruned when the tip arrives (setTip).
      if (!data || !isAllowed(data.pool_name)) continue;
      if (!Number.isInteger(data.height) || data.height <= 0) continue;
      if (this.tip !== null && data.height > this.tip + MAX_HEIGHTS_ABOVE_TIP) continue;
      const floor = this.heightFloor();
      if (floor !== null && data.height < floor) {
        // A live template of an old height: the pool's next one must not be compared across it.
        if (live && typeof data.pool_name === 'string') this.markGap(data.pool_name);
        continue;
      }

      const key = templateKey(data);
      if (key === null) continue;
      const pool = data.pool_name;
      const recvMs = Number(timestampMicros(data.received_timestamp ?? data.timestamp) ?? timestampMicros(data.timestamp)!) / 1000;
      let seg: string;
      if (responseSeg !== null) {
        const skipped = skippedByPool!.get(pool);
        seg = skipped ? `${responseSeg}.${skipped.filter(t => t < recvMs).length}` : responseSeg;
      } else {
        seg = `l${this.liveRunAll}.${this.liveRunByPool.get(pool) ?? 0}`;
      }

      const existing = this.byKey.get(key);
      if (existing) {
        // Seen again (the pre-fill and the stream meet, or a later history read): this observation saw it too.
        if (!existing.segs.includes(seg)) {
          existing.segs.push(seg);
          recompute.add(pool);
        }
        continue;
      }

      const timeMs = Number(timestampMicros(data.timestamp)!) / 1000;
      const newest = newestByPool.get(pool);
      if (newest !== undefined && timeMs < newest) outOfOrder = true;
      if (newest === undefined || timeMs > newest) newestByPool.set(pool, timeMs);

      const entry: BufferedTemplate = { key, seq: this.nextSeq++, timeMs, recvMs, data, segs: [seg] };
      if (live) entry.live = true;
      this.byKey.set(key, entry);

      let list = this.byPool.get(pool);
      if (!list) this.byPool.set(pool, (list = []));
      if (list.length === 0 || compareReceived(list[list.length - 1], entry) < 0) {
        // The usual case: the pool's newest. Only its own link to the one before it is new.
        const prev = list[list.length - 1];
        list.push(entry);
        if (prev && !linked(prev, entry)) {
          entry.gapBefore = true;
          this.gapVersion++;
        }
      } else {
        let i = list.length;
        while (i > 0 && compareReceived(list[i - 1], entry) > 0) i--;
        list.splice(i, 0, entry);
        recompute.add(pool);
      }

      if (this.maxTemplateHeight === null || data.height > this.maxTemplateHeight) {
        this.maxTemplateHeight = data.height;
      }
      added++;
    }

    // A flag that changes on an entry already handed out needs consumers to rebuild (like an out-of-order arrival).
    let relinked = false;
    for (const pool of recompute) {
      const r = this.relink(pool, firstSeq);
      if (r === 'old') outOfOrder = true;
      if (r !== 'none') relinked = true;
    }
    if (added > 0) this.trim();
    if (outOfOrder) this.epoch++;
    if (added > 0 || relinked) this.changed();
    return added;
  }

  /**
   * The receive times (ms) of a response's rows that will end up below the kept heights, by pool: below the floor
   * after this response raises the current height (rows between the current floor and that one are added, then
   * trimmed, and cut there by dropRemovedFromPools).
   */
  private belowFloorByPool(templates: StratumV1Data[], isAllowed: (poolName: string) => boolean): Map<string, number[]> {
    let current = this.currentHeight;
    for (const d of templates) {
      if (!d || !Number.isInteger(d.height) || d.height <= 0 || !isAllowed(d.pool_name)) continue;
      if (this.tip !== null && d.height > this.tip + MAX_HEIGHTS_ABOVE_TIP) continue;
      if (current === null || d.height > current) current = d.height;
    }
    const out = new Map<string, number[]>();
    if (current === null) return out;
    const floor = current - this.limits.heights + 1;
    for (const d of templates) {
      if (!d || !Number.isInteger(d.height) || d.height <= 0 || d.height >= floor || !isAllowed(d.pool_name)) continue;
      const us = timestampMicros(d.received_timestamp ?? d.timestamp);
      if (us === null) continue;
      let list = out.get(d.pool_name);
      if (!list) out.set(d.pool_name, (list = []));
      list.push(Number(us) / 1000);
    }
    return out;
  }

  /** Re-derives `gapBefore` for a pool's entries: whether it changed, and on an entry added before `firstSeq`. */
  private relink(pool: string, firstSeq: number): 'none' | 'new' | 'old' {
    const list = this.byPool.get(pool);
    if (!list) return 'none';
    let changed: 'none' | 'new' | 'old' = 'none';
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const gap = i > 0 && !linked(list[i - 1], e);
      if (!!e.gapBefore === gap) continue;
      if (gap) {
        e.gapBefore = true;
        this.gapVersion++;
      } else {
        delete e.gapBefore;
      }
      if (e.seq < firstSeq) changed = 'old';
      else if (changed === 'none') changed = 'new';
    }
    return changed;
  }

  /**
   * How many templates received within `windowMs` of the newest one still follow an unproven gap (the collectors'
   * clock, not the viewer's).
   */
  pendingGaps(windowMs: number): number {
    let newest = -Infinity;
    for (const e of this.byKey.values()) if (e.recvMs > newest) newest = e.recvMs;
    let n = 0;
    for (const e of this.byKey.values()) if (e.gapBefore && e.recvMs >= newest - windowMs) n++;
    return n;
  }

  /**
   * Templates were missed (a throttled burst for `poolName`, or a pause or dropped stream for every pool): the live
   * stream's next template of the pool (or of each pool) starts a new run, so it follows a gap until a history read
   * covers it.
   */
  markGap(poolName?: string): void {
    if (poolName === undefined) this.liveRunAll++;
    else this.liveRunByPool.set(poolName, (this.liveRunByPool.get(poolName) ?? 0) + 1);
  }

  /** All entries, oldest first (receive time, then insertion order). The array is cached until the next change. */
  entries(): BufferedTemplate[] {
    if (!this.snapshot) this.snapshot = Array.from(this.byKey.values()).sort(compareEntries);
    return this.snapshot;
  }

  clear(): void {
    this.byKey.clear();
    this.byPool.clear();
    this.maxTemplateHeight = null;
    this.epoch++;
    this.changed();
  }

  /** Lowest height kept, or null while the current height is unknown. */
  private heightFloor(): number | null {
    const current = this.currentHeight;
    return current === null ? null : current - this.limits.heights + 1;
  }

  private trim(): void {
    const floor = this.heightFloor();
    let removed = false;
    if (floor !== null) {
      for (const [key, entry] of this.byKey) {
        if (entry.data.height < floor) {
          this.byKey.delete(key);
          removed = true;
        }
      }
    }
    if (this.byKey.size > this.limits.maxRows) {
      const oldestFirst = Array.from(this.byKey.values()).sort(compareEntries);
      for (const entry of oldestFirst.slice(0, this.byKey.size - this.limits.maxRows)) {
        this.byKey.delete(entry.key);
      }
      removed = true;
    }
    if (removed) {
      this.dropRemovedFromPools();
      this.recomputeMaxHeight();
    }
  }

  /**
   * Drops entries no longer in byKey from the per-pool lists. The first entry kept after a dropped one (with one
   * kept before it) is cut: what was between it and its new neighbour is gone, so the two aren't compared.
   */
  private dropRemovedFromPools(): void {
    let reflagged = false;
    for (const [pool, list] of this.byPool) {
      const kept: BufferedTemplate[] = [];
      let dropped = false;
      for (const e of list) {
        if (this.byKey.get(e.key) !== e) {
          dropped = true;
          continue;
        }
        if (dropped && kept.length > 0) {
          e.cut = true;
          if (!e.gapBefore) {
            e.gapBefore = true;
            this.gapVersion++;
            reflagged = true;
          }
        }
        dropped = false;
        kept.push(e);
      }
      if (kept.length === 0) this.byPool.delete(pool);
      else if (kept.length !== list.length) this.byPool.set(pool, kept);
    }
    // A flag changed on an entry already handed out: consumers rebuild.
    if (reflagged) this.epoch++;
  }

  private recomputeMaxHeight(): void {
    let max: number | null = null;
    for (const entry of this.byKey.values()) {
      if (max === null || entry.data.height > max) max = entry.data.height;
    }
    this.maxTemplateHeight = max;
  }

  private newestByPool(): Map<string, number> {
    const newest = new Map<string, number>();
    for (const entry of this.byKey.values()) {
      const t = newest.get(entry.data.pool_name);
      if (t === undefined || entry.timeMs > t) newest.set(entry.data.pool_name, entry.timeMs);
    }
    return newest;
  }

  private changed(): void {
    this.snapshot = null;
    this.version++;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Per-visual "recent" rules. Inputs are entries() (oldest first); outputs stay oldest first.
// ---------------------------------------------------------------------------------------------------------------

type PoolFilter = (poolName: string) => boolean;

/**
 * Table and Sankey: each pool's latest template (by receive time) at or above `minHeight`, which is what the live
 * stream would have left them showing.
 */
export function latestPerPool(
  entries: BufferedTemplate[],
  { minHeight, isPoolVisible }: { minHeight?: number | null; isPoolVisible?: PoolFilter } = {},
): BufferedTemplate[] {
  const latest = new Map<string, BufferedTemplate>();
  for (const entry of entries) {
    if (minHeight !== undefined && minHeight !== null && entry.data.height < minHeight) continue;
    if (isPoolVisible && !isPoolVisible(entry.data.pool_name)) continue;
    const prev = latest.get(entry.data.pool_name);
    if (!prev || compareEntries(entry, prev) > 0) latest.set(entry.data.pool_name, entry);
  }
  return Array.from(latest.values()).sort(compareEntries);
}

/**
 * Timing chart: everything received at or after `cutoffMs`, plus each pool's last template before it (the chart
 * draws a bar from each template to the next, so the bar crossing the left edge needs its start).
 */
export function chartWindow(
  entries: BufferedTemplate[],
  cutoffMs: number,
  { isPoolVisible }: { isPoolVisible?: PoolFilter } = {},
): BufferedTemplate[] {
  const lastBefore = new Map<string, BufferedTemplate>();
  const inWindow: BufferedTemplate[] = [];
  for (const entry of entries) {
    if (isPoolVisible && !isPoolVisible(entry.data.pool_name)) continue;
    if (entry.timeMs >= cutoffMs) {
      inWindow.push(entry);
    } else {
      lastBefore.set(entry.data.pool_name, entry);
    }
  }
  return [...lastBefore.values(), ...inWindow].sort(compareEntries);
}
