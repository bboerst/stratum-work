import { describe, expect, it } from 'vitest';
import { laneSegments, layoutTimeline, placeEpisodes, timeX } from '../unknown-parents/layout';

const ep = (parent: string, from: number, to: number, pools: string[], kind = 'bitcoin_block') =>
  ({ parent, kind, from, to, pools: pools.map(pool => ({ pool })) });

describe('timeX', () => {
  it('maps linearly and clamps', () => {
    expect(timeX(50, 0, 100, 200)).toBe(100);
    expect(timeX(-5, 0, 100, 200)).toBe(0);
    expect(timeX(500, 0, 100, 200)).toBe(200);
    expect(timeX(5, 10, 10, 200)).toBe(0);           // empty range
  });
});

describe('placeEpisodes', () => {
  const api = (parent: string, height: number, first: number | null, last: number | null, kind = 'other_chain') =>
    ({ parent, kind, height, pools: [{ pool: 'P' }], facts: { tip_at_first: first, tip_at_last: last } });

  it('places an episode at the heights being mined while it lasted, by our tip, never its own (foreign) height', () => {
    const { placed, unplaced } = placeEpisodes([
      api('o', 6_976_415, 970_000, 970_002),          // another chain: placed by our tip
      api('b', 970_101, 970_100, 970_100, 'bitcoin_block'),
      api('s', 970_050, 970_049, null),               // no tip at the last template: one block wide
    ], 960_000, 972_096);
    expect(unplaced).toBe(0);
    expect(placed.map(e => [e.parent, e.from, e.to])).toEqual([
      ['o', 970_001, 970_003], ['b', 970_101, 970_101], ['s', 970_050, 970_050],
    ]);
  });
  it('places one without a tip by its own height only inside the domain, and counts the rest', () => {
    const { placed, unplaced } = placeEpisodes([
      api('in', 965_000, null, null, 'bitcoin_block'),
      api('far', 6_976_415, null, null),
      api('low', 100, null, null),
    ], 960_000, 972_096);
    expect(placed.map(e => [e.parent, e.from, e.to])).toEqual([['in', 965_000, 965_000]]);
    expect(unplaced).toBe(2);
  });
  it('lays the placed episodes out on a height axis', () => {
    const { placed } = placeEpisodes([api('a', 0, 970_999, 971_499), api('b', 0, 971_999, 971_999)], 970_000, 972_000);
    const [a, b] = layoutTimeline(placed, 970_000, 972_000, 2000, 4).marks;
    expect(a).toMatchObject({ x: 1000, w: 500 });
    expect(b).toMatchObject({ x: 1996, w: 4 });     // the height after our tip: at the right edge, inside the plot
  });
});

describe('layoutTimeline', () => {
  it('a race across pools is one column; one pool\'s bursts line up on its row', () => {
    const l = layoutTimeline([
      ep('r', 400, 500, ['P2', 'P1', 'P3']),
      ep('o1', 100, 100, ['P1'], 'other_chain'),
      ep('o2', 700, 701, ['P1'], 'other_chain'),
    ], 0, 1000, 1000);
    expect(l.pools).toEqual(['P1', 'P2', 'P3']);       // most episodes first, then by name
    const race = l.marks.filter(m => m.parent === 'r');
    expect(new Set(race.map(m => m.x))).toEqual(new Set([400]));
    expect(race.map(m => m.row).sort()).toEqual([0, 1, 2]);
    expect(race[0].w).toBe(100);                       // as wide as the episode
    expect(l.marks.filter(m => m.row === 0).map(m => m.parent)).toEqual(['r', 'o1', 'o2']);
  });
  it('gives short episodes the minimum width and keeps marks inside the plot', () => {
    const l = layoutTimeline([ep('a', 100, 100, ['P']), ep('b', 999, 1000, ['P']), ep('c', -50, 2000, ['P'])], 0, 1000, 500, 4);
    const [a, b, c] = l.marks;
    expect(a).toMatchObject({ x: 50, w: 4 });
    expect(b.x + b.w).toBeLessThanOrEqual(500);
    expect(b).toMatchObject({ x: 496, w: 4 });
    expect(c).toMatchObject({ x: 0, w: 500 });         // clamped to the window
  });
  it('is empty without episodes', () => {
    expect(layoutTimeline([], 0, 1, 100)).toEqual({ pools: [], marks: [] });
  });
});

describe('laneSegments', () => {
  it('merges a pool\'s consecutive templates on one parent, until its next parent', () => {
    const segs = laneSegments([
      { pool: 'A', t: 0, label: 'best' }, { pool: 'A', t: 10, label: 'best' }, { pool: 'A', t: 30, label: 'this' },
      { pool: 'A', t: 50, label: 'this' }, { pool: 'A', t: 60, label: 'best' },
      { pool: 'B', t: 40, label: 'this' },
    ], 0, 100, 100, 2);
    expect(segs).toEqual([
      { pool: 'A', label: 'best', x: 0, w: 30, from: 0, to: 10, n: 2 },
      { pool: 'A', label: 'this', x: 30, w: 30, from: 30, to: 50, n: 2 },
      { pool: 'A', label: 'best', x: 60, w: 2, from: 60, to: 60, n: 1 },   // the last run: at least the minimum
      { pool: 'B', label: 'this', x: 40, w: 2, from: 40, to: 40, n: 1 },
    ]);
  });
  it('splits a run where the key (e.g. the parent block) changes', () => {
    const segs = laneSegments([
      { pool: 'A', t: 0, label: 'best', key: 1 }, { pool: 'A', t: 10, label: 'best', key: 1 }, { pool: 'A', t: 20, label: 'best', key: 2 },
    ], 0, 100, 100, 2);
    expect(segs.map(s => [s.from, s.to, s.w])).toEqual([[0, 10, 20], [20, 20, 2]]);
  });
  it('keeps a minimum-width run at the right edge inside the plot', () => {
    expect(laneSegments([{ pool: 'A', t: 100, label: 'this' }], 0, 100, 100, 4)[0]).toMatchObject({ x: 96, w: 4 });
  });
});
