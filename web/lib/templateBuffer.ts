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
  data: StratumV1Data;
  /** Templates from this pool were missed just before this one (markGap): change detection doesn't compare it. */
  gapBefore?: boolean;
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
 * It's the same for a template whether it came from the stream or the API (the API's id, `<source>-<µs>-<job_id>`,
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

export class TemplateBuffer {
  private readonly limits: TemplateBufferLimits;
  private readonly byKey = new Map<string, BufferedTemplate>();
  private nextSeq = 1;
  private tip: number | null = null;
  private maxTemplateHeight: number | null = null;
  private snapshot: BufferedTemplate[] | null = null;
  /**
   * Gaps (markGap): pools whose next live template follows a gap; a counter bumped by a gap for every pool, and the
   * value each pool's last live template saw. A pool's first live template after the pre-fill follows a gap too (the
   * pre-fill and the stream don't meet exactly), which the counter's initial mismatch gives.
   */
  private readonly gapPools = new Set<string>();
  private gapAllEpoch = 0;
  private readonly liveEpochByPool = new Map<string, number>();

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
    const newestByPool = this.newestByPool();

    for (const data of templates) {
      // Other chains' templates arrive untagged (collectors don't classify, docs/design/one-templates-table.md): the
      // height bounds keep them out: at most MAX_HEIGHTS_ABOVE_TIP above the Bitcoin tip, and not below the kept
      // height range. One with a far height that arrives before the first tip is pruned when the tip arrives (setTip).
      if (!data || !isAllowed(data.pool_name)) continue;
      if (!Number.isInteger(data.height) || data.height <= 0) continue;
      if (this.tip !== null && data.height > this.tip + MAX_HEIGHTS_ABOVE_TIP) continue;
      const floor = this.heightFloor();
      if (floor !== null && data.height < floor) continue;

      const key = templateKey(data);
      if (key === null) continue;

      if (this.byKey.has(key)) continue;

      const timeMs = Number(timestampMicros(data.timestamp)!) / 1000;
      const newest = newestByPool.get(data.pool_name);
      if (newest !== undefined && timeMs < newest) outOfOrder = true;
      if (newest === undefined || timeMs > newest) newestByPool.set(data.pool_name, timeMs);

      // A gap applies to the pool's next live template in receive order (not to an older one arriving late, nor to
      // the pre-fill), and only when the pool had a template before it.
      let gapBefore = false;
      if (live && (newest === undefined || timeMs >= newest)) {
        gapBefore = newest !== undefined
          && (this.gapPools.has(data.pool_name) || this.liveEpochByPool.get(data.pool_name) !== this.gapAllEpoch);
        this.gapPools.delete(data.pool_name);
        this.liveEpochByPool.set(data.pool_name, this.gapAllEpoch);
      }
      const seq = this.nextSeq++;
      this.byKey.set(key, gapBefore ? { key, seq, timeMs, data, gapBefore } : { key, seq, timeMs, data });
      if (this.maxTemplateHeight === null || data.height > this.maxTemplateHeight) {
        this.maxTemplateHeight = data.height;
      }
      added++;
    }

    if (added > 0) this.trim();
    if (outOfOrder) this.epoch++;
    if (added > 0) this.changed();
    return added;
  }

  /**
   * Templates were missed (a throttled burst for `poolName`, or a pause or dropped stream for every pool): the next
   * template of the pool (or of each pool) is marked `gapBefore`.
   */
  markGap(poolName?: string): void {
    if (poolName === undefined) this.gapAllEpoch++;
    else this.gapPools.add(poolName);
  }

  /** All entries, oldest first (receive time, then insertion order). The array is cached until the next change. */
  entries(): BufferedTemplate[] {
    if (!this.snapshot) this.snapshot = Array.from(this.byKey.values()).sort(compareEntries);
    return this.snapshot;
  }

  clear(): void {
    this.byKey.clear();
    this.gapPools.clear();
    this.liveEpochByPool.clear();
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
    if (removed) this.recomputeMaxHeight();
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
