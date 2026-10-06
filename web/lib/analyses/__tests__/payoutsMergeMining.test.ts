import { describe, expect, it } from 'vitest';
import { runEvidence } from '../evidence/aggregate';
import { payoutsMergeMining } from '../evidence/payoutsMergeMining';
import { DEFAULT_PARAMS, pairKey } from '../evidence/types';
import { entry, timelines } from './evidenceFixtures';

describe('payoutsMergeMining', () => {
  it('shared address and identical RSK commitment within 5 s', () => {
    const tl = timelines(
      entry('A', 0, { payoutAddresses: ['addr1'], mergeMiningCommitments: { RSK: 'r1' } }),
      entry('B', 3000, { payoutAddresses: ['addr1'], mergeMiningCommitments: { RSK: 'r1' } }),
      entry('C', 0, { payoutAddresses: ['addr3'], mergeMiningCommitments: { RSK: 'r1' } }),
      entry('D', 0, { payoutAddresses: ['addr4'] }),
    );
    const r = payoutsMergeMining.observe({ timelines: tl, nowMs: 60_000 }, DEFAULT_PARAMS);
    const addr = r.observations.find(o => (o.detail as { kind: string }).kind === 'address')!;
    expect(addr.pools).toEqual(['A', 'B']);
    expect(addr.bits).toBeCloseTo(1);
    const rsk = r.observations.find(o => (o.detail as { kind: string }).kind === 'commitment')!;
    expect(rsk.pools).toEqual(['A', 'B', 'C']);
    expect(rsk.bits).toBeCloseTo(-Math.log2(3 / 4));
  });
  it('commitments outside the window do not cluster', () => {
    const tl = timelines(entry('A', 0, { mergeMiningCommitments: { RSK: 'r' } }), entry('B', 6000, { mergeMiningCommitments: { RSK: 'r' } }));
    expect(payoutsMergeMining.observe({ timelines: tl, nowMs: 60_000 }, DEFAULT_PARAMS).observations.filter(o => o.pools.length > 1)).toHaveLength(0);
  });
  it('repeated samples of one address or commitment credit a pair once', () => {
    const es = [];
    for (let i = 0; i < 10; i++) {
      // Many templates (and a second connection for A) repeating the same address and unchanged commitment.
      const br = [`m${i}`, 'y', 'z'];
      es.push(entry('A', i * 1000, { merkleBranches: br, payoutAddresses: ['addr1'], mergeMiningCommitments: { RSK: 'r1' } }));
      es.push(entry('A', i * 1000 + 10, { connectionId: 'A-eu', merkleBranches: [`e${i}`, 'y', 'z'], payoutAddresses: ['addr1'], mergeMiningCommitments: { RSK: 'r1' } }));
      es.push(entry('B', i * 1000 + 20, { merkleBranches: br, payoutAddresses: ['addr1'], mergeMiningCommitments: { RSK: 'r1' } }));
    }
    es.push(entry('C', 0, { payoutAddresses: ['addr3'] }), entry('D', 0, { payoutAddresses: ['addr4'] }));
    const tl = timelines(...es);
    const r = payoutsMergeMining.observe({ timelines: tl, nowMs: 60_000 }, DEFAULT_PARAMS);
    const shared = r.observations.filter(o => o.pools.length > 1);
    expect(shared).toHaveLength(2); // one address, one commitment cluster
    for (const o of shared) expect(o.pools).toEqual(['A', 'B']);
    const { pairs } = runEvidence({ timelines: tl, nowMs: 60_000 }, {}, [payoutsMergeMining]);
    expect(pairs.get(pairKey('A', 'B'))!.channels.payoutsMergeMining.bits).toBeCloseTo(2); // 2 events × bits(2, 4)
    expect(r.comparable.get(pairKey('A', 'B'))).toBe(2);
  });
  it('a lagging connection interleaving old and new commitments does not re-emit the change', () => {
    const tl = timelines(
      entry('A', 0, { merkleBranches: ['a0', 'y', 'z'], mergeMiningCommitments: { RSK: 'r0' } }),
      entry('A', 10_000, { merkleBranches: ['a1', 'y', 'z'], mergeMiningCommitments: { RSK: 'r1' } }),
      entry('A', 11_000, { connectionId: 'A-eu', merkleBranches: ['a0b', 'y', 'z'], mergeMiningCommitments: { RSK: 'r0' } }),
      entry('A', 20_000, { merkleBranches: ['a2', 'y', 'z'], mergeMiningCommitments: { RSK: 'r1' } }),
      entry('B', 10_500, { mergeMiningCommitments: { RSK: 'r1' } }),
      entry('B', 11_500, { connectionId: 'B-eu', merkleBranches: ['b0b', 'y', 'z'], mergeMiningCommitments: { RSK: 'r0' } }),
      entry('B', 20_500, { merkleBranches: ['b2', 'y', 'z'], mergeMiningCommitments: { RSK: 'r1' } }),
      entry('C', 0), entry('D', 0),
    );
    const r = payoutsMergeMining.observe({ timelines: tl, nowMs: 60_000 }, DEFAULT_PARAMS);
    expect(r.observations.filter(o => o.pools.length > 1)).toHaveLength(1);
    const { pairs } = runEvidence({ timelines: tl, nowMs: 60_000 }, {}, [payoutsMergeMining]);
    expect(pairs.get(pairKey('A', 'B'))!.channels.payoutsMergeMining.bits).toBeCloseTo(1);
  });
});
