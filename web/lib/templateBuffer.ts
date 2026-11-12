/**
 * Shared, bounded buffer of recent Stratum templates for the realtime visuals (#130).
 *
 * The buffer lives above the visuals (in DataStreamProvider), so switching between the table, timing chart and
 * Sankey keeps everything collected so far. It's seeded once from history (/api/realtime-prefill) and then fed by
 * /api/stream. The two overlap, so entries are de-duplicated on templateKey().
 *
 * Pure TypeScript, no React: unit-tested in lib/__tests__/templateBuffer.test.ts.
 */
import type { StratumV1Data, TemplateOrigin } from './types';

export type { TemplateOrigin };

export interface BufferedTemplate {
  key: string;
  /** Insertion order, strictly increasing. Incremental consumers process entries with seq > the last one they saw. */
  seq: number;
  origin: TemplateOrigin;
  /** Collector receive time, ms since the epoch (from the hex-nanosecond `timestamp`). */
  timeMs: number;
  data: StratumV1Data;
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
 * De-duplication key: pool + receive time in µs + the template's content (ntime, coinbase1, coinbase2).
 *
 * It's the same for a template whether it came from the stream, the MongoDB API or the Postgres API. Neither
 * backend's id works across both (MongoDB's is a UUID, Postgres's is `<source>-<µs>-<job_id>`), and MongoDB API rows
 * don't carry job_id. Pool + µs alone is NOT unique: the collector stamps every notification from one socket read
 * with the same receive time, so one pool can send two templates in the same µs (3 of 16,310 on dev data,
 * 2026-11-12, always with different ntime/coinbase). Hex is lower-cased because Postgres returns lower-case and
 * MongoDB keeps the pool's casing.
 */
export function templateKey(
  t: Pick<StratumV1Data, 'pool_name' | 'timestamp'> & Partial<Pick<StratumV1Data, 'ntime' | 'coinbase1' | 'coinbase2'>>,
): string | null {
  const us = timestampMicros(t.timestamp);
  if (us === null || !t.pool_name) return null;
  const content = [t.ntime, t.coinbase1, t.coinbase2].map(v => (v ?? '').toLowerCase()).join('|');
  return `${t.pool_name}|${us.toString()}|${content}`;
}

/** Bitcoin templates only: the collector tags other chains' templates with chain_family (CLAUDE.md, #98). */
export function isBitcoinTemplate(t: Pick<StratumV1Data, 'chain_family'>): boolean {
  return t.chain_family === undefined || t.chain_family === null || t.chain_family === '';
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
   * Merge templates. Returns how many new entries were added. A template already buffered is not added again; if it
   * was pre-filled and now arrives live, it's marked live. Non-Bitcoin templates and pools rejected by `isAllowed`
   * are skipped.
   */
  add(
    templates: StratumV1Data[],
    origin: TemplateOrigin,
    isAllowed: (poolName: string) => boolean = () => true,
  ): number {
    let added = 0;
    let touched = false;
    let outOfOrder = false;
    const newestByPool = this.newestByPool();

    for (const data of templates) {
      if (!data || !isBitcoinTemplate(data) || !isAllowed(data.pool_name)) continue;
      if (!Number.isInteger(data.height) || data.height <= 0) continue;
      if (this.tip !== null && data.height > this.tip + MAX_HEIGHTS_ABOVE_TIP) continue;
      const floor = this.heightFloor();
      if (floor !== null && data.height < floor) continue;

      const key = templateKey(data);
      if (key === null) continue;

      const existing = this.byKey.get(key);
      if (existing) {
        if (origin === 'live' && existing.origin === 'prefill') {
          existing.origin = 'live';
          touched = true;
        }
        continue;
      }

      const timeMs = Number(timestampMicros(data.timestamp)!) / 1000;
      const newest = newestByPool.get(data.pool_name);
      if (newest !== undefined && timeMs < newest) outOfOrder = true;
      if (newest === undefined || timeMs > newest) newestByPool.set(data.pool_name, timeMs);

      this.byKey.set(key, { key, seq: this.nextSeq++, origin, timeMs, data });
      if (this.maxTemplateHeight === null || data.height > this.maxTemplateHeight) {
        this.maxTemplateHeight = data.height;
      }
      added++;
    }

    if (added > 0) this.trim();
    if (outOfOrder) this.epoch++;
    if (added > 0 || touched) this.changed();
    return added;
  }

  /** All entries, oldest first (receive time, then insertion order). The array is cached until the next change. */
  entries(): BufferedTemplate[] {
    if (!this.snapshot) this.snapshot = Array.from(this.byKey.values()).sort(compareEntries);
    return this.snapshot;
  }

  clear(): void {
    this.byKey.clear();
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

/** Earliest receive time of a template that came over the live stream, or null if none has yet. */
export function liveSinceMs(entries: BufferedTemplate[]): number | null {
  for (const entry of entries) {
    if (entry.origin === 'live') return entry.timeMs;
  }
  return null;
}

/** The template with its origin attached, for components that only take StratumV1Data. */
export function withOrigin(entry: BufferedTemplate): StratumV1Data {
  return { ...entry.data, origin: entry.origin };
}
