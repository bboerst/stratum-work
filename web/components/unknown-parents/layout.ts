/**
 * Layout math for the Unknown parents page (components/UnknownParents.tsx): the episode timeline (one row per pool, a
 * mark per episode and pool, as wide as the episode) and the drill-in swimlanes (one lane per pool, a tick per
 * template). Pure functions, unit-tested in components/__tests__/unknownParentsLayout.test.ts.
 */

export interface TimelineEpisode {
  parent: string;
  kind: string;
  first_ms: number;
  last_ms: number;
  pools: { pool: string }[];
}

export interface TimelineMark {
  parent: string;
  kind: string;
  row: number;
  x: number;                     // px from the plot's left edge
  w: number;                     // px, at least minWidth
}

export interface TimelineLayout {
  pools: string[];               // row order: most episodes first, then by name
  marks: TimelineMark[];
}

/** x of time t on [start, end] → [0, width], clamped. */
export function timeX(t: number, start: number, end: number, width: number): number {
  if (end <= start) return 0;
  return Math.min(width, Math.max(0, ((t - start) / (end - start)) * width));
}

/**
 * Marks for every (episode, pool): x at the episode's first template, width its duration, at least `minWidth` so a
 * burst of seconds still shows, kept inside the plot. An episode built on by many pools at once lands at the same x on
 * each of their rows, a column; one pool's repeated episodes line up on its row.
 */
export function layoutTimeline(
  episodes: TimelineEpisode[], start: number, end: number, width: number, minWidth = 3,
): TimelineLayout {
  const count = new Map<string, number>();
  for (const e of episodes) for (const p of e.pools) count.set(p.pool, (count.get(p.pool) ?? 0) + 1);
  const pools = [...count.keys()].sort((a, b) => (count.get(b)! - count.get(a)!) || (a < b ? -1 : a > b ? 1 : 0));
  const row = new Map(pools.map((p, i) => [p, i]));
  const marks: TimelineMark[] = [];
  for (const e of episodes) {
    const x0 = timeX(e.first_ms, start, end, width);
    const w = Math.min(width, Math.max(minWidth, timeX(e.last_ms, start, end, width) - x0));
    const x = Math.min(x0, width - w);
    for (const p of e.pools) marks.push({ parent: e.parent, kind: e.kind, row: row.get(p.pool)!, x, w });
  }
  return { pools, marks };
}

export interface LaneTick {
  x: number;
  label: string;
}

/**
 * Drill-in ticks per pool lane, grouped by label, as one SVG path per (lane, label): "M x y v h" per tick, rounded to
 * half pixels so a few thousand templates draw as a handful of elements.
 */
export function lanePaths(
  ticks: { pool: string; t: number; label: string }[], pools: string[], start: number, end: number, width: number,
  laneHeight: number, tickHeight: number,
): { pool: string; label: string; d: string }[] {
  const lane = new Map(pools.map((p, i) => [p, i]));
  const paths = new Map<string, { pool: string; label: string; parts: string[] }>();
  for (const k of ticks) {
    const i = lane.get(k.pool);
    if (i === undefined) continue;
    const key = `${k.pool}\u0000${k.label}`;
    let p = paths.get(key);
    if (!p) paths.set(key, p = { pool: k.pool, label: k.label, parts: [] });
    const x = Math.round(timeX(k.t, start, end, width) * 2) / 2;
    const y = i * laneHeight + (laneHeight - tickHeight) / 2;
    p.parts.push(`M${x} ${y}v${tickHeight}`);
  }
  return [...paths.values()].map(p => ({ pool: p.pool, label: p.label, d: p.parts.join('') }));
}

/** Index of the tick nearest to x among sorted xs (binary search), or -1 when empty. */
export function nearestIndex(xs: number[], x: number): number {
  if (xs.length === 0) return -1;
  let lo = 0, hi = xs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo > 0 && Math.abs(xs[lo - 1] - x) <= Math.abs(xs[lo] - x) ? lo - 1 : lo;
}
