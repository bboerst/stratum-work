import { describe, expect, it } from 'vitest';
import { identicalChanges } from '../evidence/identicalChanges';
import { DEFAULT_PARAMS } from '../evidence/types';
import { entry, merkleChange, timelines } from './evidenceFixtures';

const T0 = 1_000_000;
const obs = (tl: ReturnType<typeof timelines>) => identicalChanges.observe({ timelines: tl, nowMs: T0 + 60_000 }, DEFAULT_PARAMS);

describe('identicalChanges', () => {
  it('same change within 2 s by 2 of 4 pools = one 1-bit observation', () => {
    const tl = timelines(
      entry('A', T0, { change: merkleChange(['m1']) }), entry('B', T0 + 1500, { change: merkleChange(['m1']) }),
      entry('C', T0, { change: merkleChange(['c1']) }), entry('D', T0, { change: merkleChange(['d1']) }),
    );
    const r = obs(tl);
    const shared = r.observations.filter(o => o.pools.length > 1);
    expect(shared).toHaveLength(1);
    expect(shared[0].bits).toBeCloseTo(1);
  });
  it('a change every pool made carries ~0 bits', () => {
    const tl = timelines(...['A', 'B', 'C', 'D'].map(p => entry(p, T0, { change: merkleChange(['all']) })));
    expect(obs(tl).observations.every(o => o.bits === 0)).toBe(true);
  });
  it('outside the window is not shared; tip-switch-only changes are ignored', () => {
    const tl = timelines(
      entry('A', T0, { change: merkleChange(['m1']) }), entry('B', T0 + 2500, { change: merkleChange(['m1']) }),
      entry('C', T0, { change: { hasChanges: true, changeTypes: ['P', 'H'], changeDetails: { prevHash: { old: 'a', new: 'b' }, height: { old: 1, new: 2 } } } as never }),
    );
    expect(obs(tl).observations.filter(o => o.pools.length > 1)).toHaveLength(0);
  });
});
