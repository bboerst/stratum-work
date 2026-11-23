/**
 * The fork timeline's time axis (components/ForkTimeline.tsx): quiet periods compressed, and the block arrival markers
 * placed on it. Pure, so the placement can be unit-tested (lib/__tests__/forkTimelineAxis.test.ts). Times are ns.
 */

export interface TimeZone {
  type: "active" | "gap";
  startNs: number;
  endNs: number;
  visualStartPct: number;
  visualEndPct: number;
}

/**
 * Active zones around the events (padded), with the quiet stretches between them shrunk to a few percent each. null:
 * no compression (a short span, no events, or nothing to compress).
 */
export function buildTimeZones(
  transitionTimesNs: number[],
  globalMinNs: number,
  globalMaxNs: number,
): TimeZone[] | null {
  const duration = globalMaxNs - globalMinNs;
  if (duration <= 0) return null;

  const durationSec = duration / 1_000_000_000;
  if (durationSec < 60) return null;
  if (transitionTimesNs.length === 0) return null;

  const PADDING_NS = Math.min(5_000_000_000, duration * 0.10);
  // events closer than this share one zone: 5% of the span, so a few stragglers minutes apart don't merge into one long
  // zone that takes the width from the first seconds (where the choices are)
  const GAP_THRESHOLD_NS = Math.max(10_000_000_000, duration * 0.05);
  const GAP_VISUAL_PCT = 2.5;

  const eventPoints = [globalMinNs, ...transitionTimesNs, globalMaxNs];
  const rawZones = eventPoints.map((t) => ({
    start: Math.max(globalMinNs, t - PADDING_NS),
    end: Math.min(globalMaxNs, t + PADDING_NS),
  }));

  rawZones.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [{ ...rawZones[0] }];
  for (let i = 1; i < rawZones.length; i++) {
    const last = merged[merged.length - 1];
    if (rawZones[i].start <= last.end + GAP_THRESHOLD_NS) {
      last.end = Math.max(last.end, rawZones[i].end);
    } else {
      merged.push({ ...rawZones[i] });
    }
  }

  if (merged.length <= 1) return null;

  const numGaps = merged.length - 1;
  const totalGapPct = Math.min(numGaps * GAP_VISUAL_PCT, 12);
  const perGapPct = totalGapPct / numGaps;
  const activePct = 100 - totalGapPct;
  const totalActiveDuration = merged.reduce((s, z) => s + (z.end - z.start), 0);
  if (totalActiveDuration <= 0) return null;

  const zones: TimeZone[] = [];
  let pos = 0;
  for (let i = 0; i < merged.length; i++) {
    const z = merged[i];
    const zPct = ((z.end - z.start) / totalActiveDuration) * activePct;
    zones.push({ type: "active", startNs: z.start, endNs: z.end, visualStartPct: pos, visualEndPct: pos + zPct });
    pos += zPct;
    if (i < merged.length - 1) {
      zones.push({ type: "gap", startNs: z.end, endNs: merged[i + 1].start, visualStartPct: pos, visualEndPct: pos + perGapPct });
      pos += perGapPct;
    }
  }
  return zones;
}

/** A time's position on the axis, in percent of its width (linear without zones; inside a gap, linear across it). */
export function mapTimeToVisual(
  timeNs: number,
  zones: TimeZone[] | null,
  globalMinNs: number,
  durationNs: number,
): number {
  if (!zones || durationNs <= 0) {
    if (durationNs <= 0) return 0;
    return ((timeNs - globalMinNs) / durationNs) * 100;
  }
  for (const zone of zones) {
    if (timeNs <= zone.endNs) {
      if (timeNs < zone.startNs) return zone.visualStartPct;
      const span = zone.endNs - zone.startNs;
      if (span <= 0) return zone.visualStartPct;
      const frac = (timeNs - zone.startNs) / span;
      return zone.visualStartPct + frac * (zone.visualEndPct - zone.visualStartPct);
    }
  }
  return zones[zones.length - 1].visualEndPct;
}

/** A block at height - 1 or height and when our node saw it (null: no seen time recorded, e.g. older history). */
export interface ArrivalBlock {
  hash: string;
  height: number;
  seen_ms: number | null;
  best: boolean;
  miner?: string | null;
  /** Known from the stale-block records only: seen_ms is when they first recorded it (polled), not our node's arrival. */
  stale_only?: boolean;
  /**
   * When our feeds first built on it (its first template as a parent): where its line goes when our node's arrival
   * wasn't recorded. Not the header time, which its miner sets and which is often seconds to minutes off.
   */
  work_ms?: number | null;
  /** Set by markerBlocks: seen_ms is the first work on it, not an arrival. */
  firstWork?: boolean;
}

/**
 * The blocks to draw, each at one time: when it reached our node where that was recorded (seen_at, from about
 * 976,000), else when our feeds first built on it, flagged as such. A stale-only block's recorded time is a poll, not an
 * arrival: it gets its first work too. A block with neither gets no line.
 */
export function markerBlocks(blocks: readonly ArrivalBlock[] | null | undefined): ArrivalBlock[] {
  return (blocks ?? []).flatMap((b): ArrivalBlock[] => {
    const seen = !b.stale_only && b.seen_ms != null && Number.isFinite(b.seen_ms);
    if (seen) return [{ ...b, firstWork: false }];
    if (b.work_ms == null || !Number.isFinite(b.work_ms)) return [];
    return [{ ...b, seen_ms: b.work_ms, stale_only: false, firstWork: true }];
  });
}

export interface BlockMarker {
  hash: string;
  height: number;
  best: boolean;
  miner: string | null;
  staleOnly: boolean;
  /** seenMs is when our feeds first built on it (no arrival recorded). */
  firstWork: boolean;
  seenMs: number;
  /** Position on the axis, 0..100. An arrival outside the axis sits at its edge (edge says which). */
  pct: number;
  edge: "before" | "after" | null;
  /** Label row: 1 lifts a label above its neighbour when two arrive within staggerPct of each other. */
  row: 0 | 1;
}

/** Block arrivals closer to the templates than this widen the axis to include them (the race's blocks, not history). */
export const ARRIVAL_EXTEND_NS = 10 * 60 * 1_000_000_000;

/**
 * The axis span: the templates' [min, max], widened to every seen block arrival within extendNs of it, so a block that
 * reached us moments before the first template (the usual case for height - 1) gets a marker on the axis. Without such
 * blocks it is the templates' span unchanged.
 */
export function axisDomain(
  dataMinNs: number,
  dataMaxNs: number,
  blocks: readonly ArrivalBlock[] | null | undefined,
  extendNs: number = ARRIVAL_EXTEND_NS,
): { minNs: number; maxNs: number } {
  let minNs = dataMinNs, maxNs = dataMaxNs;
  for (const b of blocks ?? []) {
    if (b.seen_ms === null || !Number.isFinite(b.seen_ms)) continue;
    const t = b.seen_ms * 1_000_000;
    if (t < dataMinNs && dataMinNs - t <= extendNs) minNs = Math.min(minNs, t);
    if (t > dataMaxNs && t - dataMaxNs <= extendNs) maxNs = Math.max(maxNs, t);
  }
  return { minNs, maxNs };
}

/**
 * The markers for the blocks that have a seen time, on the axis [minNs, maxNs] with its zones (a block inside a
 * compressed quiet period lands at its compressed position; its label stays the exact height and time). Labels of
 * blocks that arrived close together alternate rows, as in a race (two blocks at one height seconds apart).
 */
export function placeBlockMarkers(
  blocks: readonly ArrivalBlock[] | null | undefined,
  zones: TimeZone[] | null,
  minNs: number,
  maxNs: number,
  staggerPct: number,
): BlockMarker[] {
  const out: BlockMarker[] = [];
  const duration = maxNs - minNs;
  const seen = (blocks ?? []).filter(b => b.seen_ms !== null && Number.isFinite(b.seen_ms))
    .sort((a, b) => a.seen_ms! - b.seen_ms! || a.height - b.height || a.hash.localeCompare(b.hash));
  let lastPct = -Infinity, lastRow: 0 | 1 = 1;
  for (const b of seen) {
    const t = b.seen_ms! * 1_000_000;
    const edge = t < minNs ? "before" : t > maxNs ? "after" : null;
    const pct = edge === "before" ? 0 : edge === "after" ? 100
      : Math.min(100, Math.max(0, mapTimeToVisual(t, zones, minNs, duration)));
    const row: 0 | 1 = pct - lastPct < staggerPct ? (lastRow === 0 ? 1 : 0) : 0;
    out.push({ hash: b.hash, height: b.height, best: b.best, miner: b.miner ?? null, staleOnly: b.stale_only === true, firstWork: b.firstWork === true, seenMs: b.seen_ms!, pct, edge, row });
    lastPct = pct; lastRow = row;
  }
  return out;
}
