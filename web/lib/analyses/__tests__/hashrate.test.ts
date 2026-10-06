import { describe, expect, it } from 'vitest';
import { groupShare, hashrateShares, poolIdentityMap } from '../hashrate';
import { decodeTemplate } from '@/lib/templates/decode';
import { makeRaw } from '@/lib/templates/__tests__/fixtures';

const blk = (h: number, name?: string) => ({ hash: String(h), height: h, mining_pool: name ? { id: 1, name } : undefined }) as never;

describe('hashrateShares', () => {
  const blocks = [
    ...Array.from({ length: 50 }, (_, i) => blk(1000 + i, 'Foundry USA')),
    ...Array.from({ length: 30 }, (_, i) => blk(2000 + i, 'AntPool')),
    ...Array.from({ length: 15 }, (_, i) => blk(3000 + i, 'Hidden')),
    ...Array.from({ length: 5 }, (_, i) => blk(4000 + i)),
  ];
  it('splits observed identities from not-observed with Wilson ranges', () => {
    const s = hashrateShares(blocks, new Set(['Foundry USA', 'AntPool']));
    expect(s.total).toBe(100);
    expect(s.identities.map(r => [r.name, r.blocks])).toEqual([['Foundry USA', 50], ['AntPool', 30]]);
    expect(s.notObserved.blocks).toBe(20);
    expect(s.identities[0].lo).toBeLessThan(0.5);
    expect(s.identities[0].hi).toBeGreaterThan(0.5);
  });
  it('uses only the latest window of blocks', () => {
    expect(hashrateShares(blocks, new Set(['AntPool']), 10).identities).toEqual([]);
  });
  it('is unavailable with no blocks', () => expect(hashrateShares([], new Set()).unavailable).toBe(true));
  it('groupShare sums counts', () => {
    const s = hashrateShares(blocks, new Set(['Foundry USA', 'AntPool']));
    expect(groupShare(s, ['Foundry USA', 'AntPool']).blocks).toBe(80);
  });
});

describe('poolIdentityMap', () => {
  it('maps a pool label to its most frequent identity', () => {
    const id = (name: string) => () => ({ id: '1', name, method: 'tag' as const });
    const ts = [
      decodeTemplate(makeRaw({ pool_name: 'L' }), 'a', id('X')),
      decodeTemplate(makeRaw({ pool_name: 'L' }), 'b', id('X')),
      decodeTemplate(makeRaw({ pool_name: 'L' }), 'c', id('Y')),
      decodeTemplate(makeRaw({ pool_name: 'M' }), 'd', () => ({ id: null, name: 'Unknown', method: 'none' as const })),
    ];
    expect([...poolIdentityMap(ts)]).toEqual([['L', 'X'], ['M', 'M']]);
  });
});
