import { describe, expect, it } from 'vitest';
import { lanePaths, layoutTimeline, nearestIndex, timeX } from '../unknown-parents/layout';

const ep = (parent: string, first: number, last: number, pools: string[], kind = 'bitcoin_block') =>
  ({ parent, kind, first_ms: first, last_ms: last, pools: pools.map(pool => ({ pool })) });

describe('timeX', () => {
  it('maps linearly and clamps', () => {
    expect(timeX(50, 0, 100, 200)).toBe(100);
    expect(timeX(-5, 0, 100, 200)).toBe(0);
    expect(timeX(500, 0, 100, 200)).toBe(200);
    expect(timeX(5, 10, 10, 200)).toBe(0);           // empty range
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

describe('lanePaths', () => {
  it('one path per lane and label, ticks centred in their lane', () => {
    const paths = lanePaths([
      { pool: 'A', t: 0, label: 'this' }, { pool: 'A', t: 50, label: 'this' }, { pool: 'B', t: 100, label: 'best' },
      { pool: 'Z', t: 10, label: 'this' },             // not a lane: dropped
    ], ['A', 'B'], 0, 100, 200, 20, 10);
    expect(paths).toEqual([
      { pool: 'A', label: 'this', d: 'M0 5v10M100 5v10' },
      { pool: 'B', label: 'best', d: 'M200 25v10' },
    ]);
  });
});

describe('nearestIndex', () => {
  it('finds the nearest sorted x', () => {
    expect(nearestIndex([], 3)).toBe(-1);
    expect(nearestIndex([10, 20, 30], 0)).toBe(0);
    expect(nearestIndex([10, 20, 30], 24)).toBe(1);
    expect(nearestIndex([10, 20, 30], 26)).toBe(2);
    expect(nearestIndex([10, 20, 30], 99)).toBe(2);
    expect(nearestIndex([10, 20], 15)).toBe(0);       // a tie goes left
  });
});
