import { describe, expect, it } from 'vitest';
import { TemplateStore } from '@/lib/templates/store';
import { makeRaw, tsHex } from '@/lib/templates/__tests__/fixtures';
import type { RawTemplate } from '@/lib/templates/types';
import { CHANNELS, runEvidence } from '../evidence/aggregate';
import { pairKey } from '../evidence/types';

function evidence(extraConnection: boolean) {
  const now = 1_700_000_600_000;
  const store = new TemplateStore({ retentionMs: null, now: () => now, schedule: () => 0 });
  const raws: RawTemplate[] = [];
  for (let i = 0; i < 12; i++) {
    const at = now - 300_000 + i * 20_000, br = [`b${i}`, 'y', 'z'];
    raws.push(makeRaw({ pool_name: 'A', connection_id: 'us/A/observe', timestamp: tsHex(at), merkle_branches: br }));
    if (extraConnection) raws.push(makeRaw({ pool_name: 'A', connection_id: 'eu/A/observe', timestamp: tsHex(at + 30), merkle_branches: br }));
    raws.push(makeRaw({ pool_name: 'B', timestamp: tsHex(at + 50), merkle_branches: br }));
    raws.push(makeRaw({ pool_name: 'C', timestamp: tsHex(at), merkle_branches: [`c${i}`, 'y', 'z'] }));
  }
  store.ingest(raws);
  const tl = new Map(store.poolNames().map(p => [p, store.poolView(p)]));
  return runEvidence({ timelines: tl, nowMs: now });
}

describe('evidence with multiple connections', () => {
  it('runs every channel', () => {
    expect(CHANNELS.map(c => c.id)).toEqual(['txSelection', 'identicalChanges', 'tipSwitch', 'payoutsMergeMining']);
  });
  it('adds no self pair and leaves A–B evidence unchanged', () => {
    const one = evidence(false), two = evidence(true);
    expect(Array.from(two.pairs.values()).some(p => p.a === p.b)).toBe(false);
    expect(two.pairs.get(pairKey('A', 'B'))!.total).toBeCloseTo(one.pairs.get(pairKey('A', 'B'))!.total, 6);
    expect(one.pairs.get(pairKey('A', 'B'))!.total).toBeGreaterThan(0);
  });
});
