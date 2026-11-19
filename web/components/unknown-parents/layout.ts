/**
 * Layout math for the Unknown parents page (components/UnknownParents.tsx): the episode timeline (one row per pool, a
 * mark per episode and pool, as wide as the episode) and the drill-in swimlanes (one lane per pool, a bar per run of
 * templates on one parent). Pure functions, unit-tested in components/__tests__/unknownParentsLayout.test.ts.
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

export interface LaneSegment {
  pool: string;
  label: string;
  x: number;
  w: number;
  from: number;                  // ms: the first template of the run
  to: number;                    // ms: the last template of the run
  n: number;                     // templates in the run
}

/**
 * Drill-in bars: per pool, consecutive templates on the same parent merged into one segment that lasts until the
 * pool's next template on another parent (the pool was working on that parent meanwhile), or to its last template.
 * `key` (optional) splits runs further: two best-chain blocks in a row are two segments. At least `minWidth` px, so a
 * single template still shows.
 */
export function laneSegments(
  ticks: { pool: string; t: number; label: string; key?: string | number }[], start: number, end: number, width: number,
  minWidth = 2,
): LaneSegment[] {
  const byPool = new Map<string, { t: number; label: string; key?: string | number }[]>();
  for (const k of ticks) {
    const l = byPool.get(k.pool) ?? [];
    l.push(k);
    byPool.set(k.pool, l);
  }
  const out: LaneSegment[] = [];
  for (const [pool, list] of byPool) {
    list.sort((a, b) => a.t - b.t);
    let i = 0;
    while (i < list.length) {
      let j = i;
      while (j + 1 < list.length && list[j + 1].label === list[i].label && list[j + 1].key === list[i].key) j++;
      const until = j + 1 < list.length ? list[j + 1].t : list[j].t;
      const x = timeX(list[i].t, start, end, width);
      const w = Math.max(minWidth, timeX(until, start, end, width) - x);
      out.push({ pool, label: list[i].label, x: Math.min(x, width - w), w, from: list[i].t, to: list[j].t, n: j - i + 1 });
      i = j + 1;
    }
  }
  return out;
}
