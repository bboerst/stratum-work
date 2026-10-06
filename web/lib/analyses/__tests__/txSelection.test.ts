import { describe, expect, it } from 'vitest';
import { txSelection, partialScore } from '../evidence/txSelection';
import { DEFAULT_PARAMS, pairKey } from '../evidence/types';
import { entry, timelines } from './evidenceFixtures';

const T0 = 1_000_000;
const run = (tl: ReturnType<typeof timelines>, now = T0 + 60_000) => txSelection.observe({ timelines: tl, nowMs: now }, DEFAULT_PARAMS);

describe('txSelection', () => {
  it('cloned pools share one observation per distinct branch set', () => {
    const tl = timelines(
      entry('A', T0, { merkleBranches: ['x', 'y', 'z'] }), entry('B', T0 + 5, { merkleBranches: ['x', 'y', 'z'] }),
      entry('C', T0 + 9, { merkleBranches: ['p', 'q', 'r'] }), entry('D', T0 + 9, { merkleBranches: ['s', 't', 'u'] }),
    );
    const r = run(tl);
    expect(r.observations).toHaveLength(1); // repeated samples of the same state count once
    expect(r.observations[0].pools.sort()).toEqual(['A', 'B']);
    expect(r.observations[0].bits).toBeCloseTo(1); // k=2 of n=4
  });
  it('excludes templates with < 3 branches and the first 10 s after a new tip', () => {
    const tl = timelines(entry('A', T0, { merkleBranches: ['x', 'y'] }), entry('B', T0, { merkleBranches: ['x', 'y'] }));
    expect(run(tl).observations).toHaveLength(0);
    const early = timelines(entry('A', T0, { merkleBranches: ['x', 'y', 'z'] }), entry('B', T0, { merkleBranches: ['x', 'y', 'z'] }));
    expect(run(early, T0 + 9_000).observations).toHaveLength(0);
  });
  it('only compares pools on the same prevHash and drops stale pools', () => {
    const tl = timelines(
      entry('A', T0, { prevHash: 'P1', merkleBranches: ['x', 'y', 'z'] }),
      entry('B', T0, { prevHash: 'P2', merkleBranches: ['x', 'y', 'z'] }),
    );
    expect(run(tl).observations).toHaveLength(0);
    const stale = timelines(entry('A', T0), entry('B', T0));
    const r = run(stale, T0 + 10 * 60_000);
    expect(r.observations).toHaveLength(1); // shared while fresh, not re-counted after going stale
  });
  it('counts comparable events per pair as distinct joint states', () => {
    const tl = timelines(
      entry('A', T0, { merkleBranches: ['1', '2', '3'] }), entry('B', T0, { merkleBranches: ['4', '5', '6'] }),
      entry('A', T0 + 20_000, { merkleBranches: ['7', '8', '9'] }),
    );
    expect(run(tl).comparable.get(pairKey('A', 'B'))).toBe(2);
  });
  it('credits each pool pair at most once per branch set when the set grows', () => {
    const X = ['x', 'y', 'z'];
    const tl = timelines(
      entry('A', T0, { merkleBranches: X }), entry('B', T0, { merkleBranches: X }),
      entry('C', T0, { merkleBranches: ['p', 'q', 'r'] }), entry('D', T0, { merkleBranches: ['s', 't', 'u'] }),
      entry('C', T0 + 20_000, { merkleBranches: X }),
    );
    const r = run(tl);
    const pairBits = (a: string, b: string) => r.observations
      .filter(o => o.pools.includes(a) && o.pools.includes(b))
      .reduce((s, o) => s + o.bits, 0);
    expect(pairBits('A', 'B')).toBeCloseTo(1); // only the first credit: bits(2, 4)
    expect(pairBits('A', 'C')).toBeCloseTo(Math.log2(4 / 3)); // bits(3, 4)
    expect(pairBits('B', 'C')).toBeCloseTo(Math.log2(4 / 3));
  });
  it('partialScore', () => expect(partialScore(['a', 'b', 'c'], ['a', 'x', 'c', 'd'])).toBeCloseTo(0.5));
});
