import { describe, expect, it } from 'vitest';
import { runEvidence } from '../evidence/aggregate';
import { pairKey } from '../evidence/types';
import { entry, merkleChange, timelines } from './evidenceFixtures';

const T0 = 1_000_000;
describe('runEvidence', () => {
  it('sums bits per pair and marks thin channels insufficient', () => {
    const es = [];
    for (let i = 0; i < 6; i++) {
      const at = T0 + i * 30_000, br = [`x${i}`, 'y', 'z'];
      es.push(entry('A', at, { merkleBranches: br, change: merkleChange(br) }), entry('B', at + 100, { merkleBranches: br, change: merkleChange(br) }));
      es.push(entry('C', at, { merkleBranches: [`c${i}`, 'y', 'z'], change: merkleChange([`c${i}`]) }), entry('D', at, { merkleBranches: [`d${i}`, 'y', 'z'], change: merkleChange([`d${i}`]) }));
    }
    const { pairs } = runEvidence({ timelines: timelines(...es), nowMs: T0 + 200_000 });
    const ab = pairs.get(pairKey('A', 'B'))!;
    expect(ab.channels.identicalChanges.insufficient).toBe(false);
    expect(ab.channels.identicalChanges.bits).toBeCloseTo(6); // 6 clusters × 1 bit
    expect(ab.channels.txSelection.bits).toBeCloseTo(6); // 6 distinct shared sets × bits(2, 4)
    const expectedTotal = Object.values(ab.channels).filter(c => !c.insufficient).reduce((a, c) => a + c.bits, 0);
    expect(ab.total).toBeCloseTo(expectedTotal);
    const cd = pairs.get(pairKey('C', 'D'))!;
    expect(cd.total).toBe(0);
  });
  it('a pool seen via several connections is one key and never pairs with itself', () => {
    const X = ['x', 'y', 'z'];
    const tl = timelines(
      entry('A', T0, { connectionId: 'A-1', merkleBranches: X, change: merkleChange(X) }),
      entry('A', T0 + 1, { connectionId: 'A-2', merkleBranches: X, change: merkleChange(X) }),
      entry('B', T0 + 2, { merkleBranches: ['p', 'q', 'r'], change: merkleChange(['p', 'q', 'r']) }),
      entry('C', T0 + 3, { merkleBranches: ['s', 't', 'u'], change: merkleChange(['s', 't', 'u']) }),
    );
    const { pairs, observations } = runEvidence({ timelines: tl, nowMs: T0 + 60_000 });
    expect(Array.from(pairs.keys()).sort()).toEqual([pairKey('A', 'B'), pairKey('A', 'C'), pairKey('B', 'C')].sort());
    expect(Array.from(pairs.values()).every(p => p.a !== p.b)).toBe(true);
    for (const obs of Object.values(observations)) {
      for (const o of obs) expect(new Set(o.pools).size).toBe(o.pools.length); // A never listed twice
    }
    // A's two connections agreeing with each other yields no evidence anywhere.
    for (const p of Array.from(pairs.values())) {
      expect(p.channels.txSelection.bits).toBe(0);
      expect(p.channels.identicalChanges.bits).toBe(0);
    }
  });
});
