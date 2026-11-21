/**
 * Layout math for the Forks page (components/Forks.tsx): the episode timeline in Bitcoin time (one
 * row per pool, a mark per episode and pool, over the heights being mined while it lasted) and the drill-in swimlanes (one lane per pool, a bar per run of
 * templates on one parent). Pure functions, unit-tested in components/__tests__/unknownParentsLayout.test.ts.
 */

export interface TimelineEpisode {
  parent: string;
  kind: string;
  from: number;                  // position on the axis (the timeline: a height)
  to: number;
  pools: { pool: string }[];
}

/** An episode as the API gives it: what placeEpisodes reads. */
export interface PlaceableEpisode {
  parent: string;
  kind: string;
  height: number;
  pools: { pool: string }[];
  facts: { tip_at_first: number | null; tip_at_last: number | null };
}

/**
 * Episodes in Bitcoin time: from the height being mined when the first template arrived (our tip then, + 1) to the one
 * when the last did. Another chain's episode carries a foreign height, so our tip places it, never its own height. One
 * without a tip (it arrived before any block we store) is placed at its own height only if that is within [lo, hi];
 * otherwise it isn't placed, and counted.
 */
export function placeEpisodes(episodes: PlaceableEpisode[], lo: number, hi: number): { placed: TimelineEpisode[]; unplaced: number } {
  const placed: TimelineEpisode[] = [];
  let unplaced = 0;
  for (const e of episodes) {
    const { tip_at_first: first, tip_at_last: last } = e.facts;
    if (first !== null) placed.push({ parent: e.parent, kind: e.kind, pools: e.pools, from: first + 1, to: (last ?? first) + 1 });
    else if (e.height >= lo && e.height <= hi) placed.push({ parent: e.parent, kind: e.kind, pools: e.pools, from: e.height, to: e.height });
    else unplaced++;
  }
  return { placed, unplaced };
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

/** x of a position t (a time, a height) on [start, end] → [0, width], linear, clamped. */
export function timeX(t: number, start: number, end: number, width: number): number {
  if (end <= start) return 0;
  return Math.min(width, Math.max(0, ((t - start) / (end - start)) * width));
}

/**
 * Marks for every (episode, pool): from `from` to `to` on [start, end], at least `minWidth` so an episode within one
 * block still shows, kept inside the plot. An episode built on by many pools at once lands at the same x on
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
    const x0 = timeX(e.from, start, end, width);
    const w = Math.min(width, Math.max(minWidth, timeX(e.to, start, end, width) - x0));
    const x = Math.min(x0, width - w);
    for (const p of e.pools) marks.push({ parent: e.parent, kind: e.kind, row: row.get(p.pool)!, x, w });
  }
  return { pools, marks };
}
