import { describe, expect, it } from 'vitest';
import { emptyBlockWindow, jobCadence, mergeMiningMap } from '../profiles';
import { entry, timelines } from './evidenceFixtures';

describe('profiles', () => {
  it('emptyBlockWindow measures switch → first branched template', () => {
    const tl = timelines(
      entry('A', 0, { prevHash: 'P0' }),
      entry('A', 1000, { prevHash: 'P1', merkleBranches: [] }), entry('A', 1800, { prevHash: 'P1' }),
      entry('A', 5000, { prevHash: 'P2' }),
      entry('A', 9000, { prevHash: 'P3', merkleBranches: [] }),
    );
    expect(emptyBlockWindow(tl).get('A')).toEqual([
      { prevHash: 'P1', emptyMs: 800 }, { prevHash: 'P2', emptyMs: 0 }, { prevHash: 'P3', emptyMs: null },
    ]);
  });
  it('jobCadence finds the dominant interval and phases', () => {
    const tl = timelines(...[0, 30_000, 60_000, 90_000, 120_000].map(t => entry('A', t + 5000, { merkleBranches: [String(t), 'b', 'c'] })));
    const c = jobCadence(tl).get('A')!;
    expect(c.dominantMs).toBe(30_000);
    expect(c.phases[0]).toBeCloseTo(5000 / 30_000);
  });
  it('mergeMiningMap marks identical latest commitments', () => {
    const tl = timelines(entry('A', 0, { mergeMiningCommitments: { RSK: 'x' } }), entry('B', 0, { mergeMiningCommitments: { RSK: 'x', Hathor: 'h' } }), entry('C', 0, { mergeMiningCommitments: { RSK: 'y' } }));
    const m = mergeMiningMap(tl);
    expect(m.protocols).toEqual(['Hathor', 'RSK']);
    expect(m.shared).toEqual([{ protocol: 'RSK', content: 'x', pools: ['A', 'B'] }]);
  });
});
