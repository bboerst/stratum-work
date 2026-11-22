import { describe, expect, it } from 'vitest';
import { raceRows, stripColumns, positionOf, type RaceEpisode } from '../forkRaces';

const ep = (parent: string, height: number, kind: string, o: Partial<RaceEpisode> & { prev?: string | null; tip?: number | null } = {}): RaceEpisode => ({
  parent, height, kind, first_ms: height * 1000, last_ms: height * 1000 + 60_000, invalid_coinbase: null,
  facts: { tip_at_first: o.tip === undefined ? height - 1 : o.tip, stale_block: kind === 'stale' ? { prev: o.prev ?? null } : null },
  ...o,
});

describe('raceRows', () => {
  it('joins a branch two recorded blocks deep into one race, at its first height', () => {
    const rows = raceRows([ep('s1', 101, 'stale', { prev: 'best99' }), ep('s2', 102, 'stale', { prev: 's1' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 's1', heights: [101, 102], kind: 'stale', position: 101 });
  });
  it('joins two recorded stale blocks with the same parent (a three-way race) into one', () => {
    const rows = raceRows([ep('a', 101, 'stale', { prev: 'p' }), ep('b', 101, 'stale', { prev: 'p' })]);
    expect(rows.map(r => r.episodes.length)).toEqual([2]);
  });
  it('never joins on heights alone: a branch block we never recorded stays its own row', () => {
    const rows = raceRows([ep('s1', 101, 'stale', { prev: 'p' }), ep('u', 102, 'bitcoin_block')]);
    expect(rows.map(r => r.key)).toEqual(['u', 's1']);
  });
  it('keeps two independent races at one height apart', () => {
    const rows = raceRows([ep('a', 101, 'stale', { prev: 'p' }), ep('b', 101, 'stale', { prev: 'q' })]);
    expect(rows).toHaveLength(2);
  });
  it('marks invalid work: an invalid parent, an invalid coinbase, or a finding on a race', () => {
    const rows = raceRows([ep('a', 101, 'stale', { prev: 'p', invalid_coinbase: {} }), ep('b', 200, 'invalid_parent'), ep('c', 300, 'stale', { prev: 'q' })]);
    expect(Object.fromEntries(rows.map(r => [r.key, r.invalid]))).toEqual({ a: true, b: true, c: false });
  });
  it('places another chain by our tip, never by its own heights; newest first', () => {
    const rows = raceRows([ep('o', 6_900_000, 'other_chain', { tip: 950_000 }), ep('s', 960_001, 'stale', { prev: 'p' })]);
    expect(rows.map(r => [r.key, r.position])).toEqual([['s', 960_001], ['o', 950_001]]);
    expect(positionOf(ep('x', 5, 'stale', { tip: null }))).toBe(5);
  });
});

describe('stripColumns', () => {
  it('puts each row in the epoch it began in, oldest at the bottom, and keeps empty epochs', () => {
    const rows = raceRows([ep('a', 2016 * 3 + 5, 'stale', { prev: 'p' }), ep('b', 2016 * 3 + 9, 'stale', { prev: 'q' }), ep('c', 2016 * 5, 'stale', { prev: 'r' })]);
    const cols = stripColumns(rows, 2016 * 3, 2016 * 5 + 1);
    expect(cols.map(c => c.rows.map(r => r.key))).toEqual([['a', 'b'], [], ['c']]);
  });
});
