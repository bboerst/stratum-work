import { describe, expect, it } from 'vitest';
import { TemplateStore } from '@/lib/templates/store';
import { CB1, makeRaw, tsHex } from '@/lib/templates/__tests__/fixtures';
import type { RawTemplate } from '@/lib/templates/types';
import { computeOverview, DEFAULT_OVERVIEW } from '../overview';
import { NOW, storeWithClones } from './overviewFixture';

describe('computeOverview', () => {
  it('groups cloned pools, excludes work mode, carries Wilson shares', () => {
    const o = computeOverview(storeWithClones(), DEFAULT_OVERVIEW, NOW);
    expect(o.pools).toEqual(['A', 'B', 'C', 'D']);
    const ab = o.families.find(f => f.members.includes('A'))!;
    expect(ab.members).toEqual(['A', 'B']);
    expect(ab.label).toBe('A +1');
    expect(ab.share!.blocks).toBe(60);
    expect(ab.share!.lo).toBeLessThan(0.6);
    expect(o.shares.notObserved.blocks).toBe(20);
    expect(o.summary!.k).toBe(1);
  });
  it('shares unavailable without blocks, evidence still computed', () => {
    const s = new TemplateStore({ retentionMs: null, now: () => NOW, schedule: () => 0 });
    s.ingest([makeRaw({ pool_name: 'A', timestamp: tsHex(NOW) })]);
    const o = computeOverview(s, DEFAULT_OVERVIEW, NOW);
    expect(o.shares.unavailable).toBe(true);
    expect(o.families[0].share).toBeNull();
    expect(o.summary).toBeNull();
  });
  it('merges families that share an identity so each identity is counted once', () => {
    // P and Q carry the same coinbase tag (identity "X") but distinct templates, so evidence keeps
    // them apart; R has no identity. Blocks: 50 X, 30 R-name (unidentified label), 20 other.
    const s = new TemplateStore({ retentionMs: null, now: () => NOW, schedule: () => 0 });
    const noTag = CB1.replace('2f746573742f', '2f616263642f'); // "/abcd/" — matches no pool
    const raws: RawTemplate[] = [];
    for (let i = 0; i < 40; i++) {
      const at = NOW - 3_000_000 + i * 60_000;
      raws.push(makeRaw({ pool_name: 'P', timestamp: tsHex(at), merkle_branches: [`p${i}`, 'y', 'z'] }));
      raws.push(makeRaw({ pool_name: 'Q', timestamp: tsHex(at + 500), merkle_branches: [`q${i}`, 'y', 'z'] }));
      raws.push(makeRaw({ pool_name: 'R', timestamp: tsHex(at), coinbase1: noTag, coinbase2: '', merkle_branches: [`r${i}`, 'y', 'z'] }));
    }
    s.ingest(raws);
    s.setPools([{ id: 'x', name: 'X', tags: ['/test/'], regexes: [], addresses: [] }]);
    s.ingestBlocks(Array.from({ length: 100 }, (_, i) => ({ hash: `h${i}`, height: 1000 + i, mining_pool: { id: 1, name: i < 50 ? 'X' : i < 80 ? 'R' : 'Other' } })) as never);
    const o = computeOverview(s, DEFAULT_OVERVIEW, NOW);
    expect(o.identityOf.get('P')).toBe('X');
    expect(o.identityOf.get('Q')).toBe('X');
    const pq = o.families.find(f => f.members.includes('P'))!;
    expect(pq.members).toEqual(['P', 'Q']);
    expect(pq.identities).toEqual(['X']);
    expect(pq.id).toBe('P,Q');
    expect(pq.share!.blocks).toBe(50);
    expect(o.families.find(f => f.members.includes('R'))!.members).toEqual(['R']);
    const seen = o.families.reduce<string[]>((a, f) => a.concat(f.identities), []);
    expect(new Set(seen).size).toBe(seen.length);
    const sum = o.families.reduce((a, f) => a + f.share!.share, 0) + o.shares.notObserved.share;
    expect(sum).toBeLessThanOrEqual(1 + 1e-9);
    // current = newest template among merged members (Q trails P by 500 ms).
    expect(pq.current!.pool).toBe('Q');
  });
  it('family current is the newest template among its members', () => {
    const o = computeOverview(storeWithClones(), DEFAULT_OVERVIEW, NOW);
    for (const f of o.families) {
      const newest = Math.max(...f.members.map(m => { const tl = o.timelines.get(m)!; return tl[tl.length - 1].template.receivedAtMs; }));
      expect(f.current!.receivedAtMs).toBe(newest);
    }
    expect(o.families.find(f => f.members.includes('A'))!.current!.pool).toBe('B');
  });
});
