import { describe, expect, it } from 'vitest';
import { compareModes, observeEndMs } from '../observeVsWork';
import { entry } from './evidenceFixtures';

describe('compareModes', () => {
  it('identical share over the overlapping time', () => {
    const o1 = entry('A', 0, { mode: 'observe', merkleBranches: ['x', 'y', 'z'] }).template;
    const w1 = entry('A', 0, { mode: 'work', merkleBranches: ['x', 'y', 'z'] }).template;
    const w2 = entry('A', 6000, { mode: 'work', merkleBranches: ['q', 'y', 'z'] }).template;
    const r = compareModes([o1, w1, w2], 'A', 10_000);
    expect(r.overlapMs).toBe(10_000);
    expect(r.identicalShare).toBeCloseTo(0.6);
  });
  it('null without both modes', () => expect(compareModes([entry('A', 0).template], 'A', 1000).identicalShare).toBeNull());
});

describe('observeEndMs', () => {
  it('live ends now; a past range ends at its toMs; a range reaching into the future ends now', () => {
    expect(observeEndMs({ kind: 'live' }, 5_000)).toBe(5_000);
    expect(observeEndMs({ kind: 'range', fromMs: 1_000, toMs: 2_000 }, 5_000)).toBe(2_000);
    expect(observeEndMs({ kind: 'range', fromMs: 1_000, toMs: 9_000 }, 5_000)).toBe(5_000);
  });
});
