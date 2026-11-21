/**
 * The link-preview card's pieces (lib/forksCard.ts), as the page's episode diagram draws them: our chain's tiles with
 * their miners, the parent tile per kind, "← N pools built on it" and the pool list, the header hash. Synthetic data.
 */
import { describe, expect, it } from 'vitest';
import { cardModel, fitName, headerHash, nameList, shortHash, type CardBlock } from '../forksCard';
import type { Episode } from '../unknownParents';

const PARENT = '0000000000000000000327cda2d3d99ac20342aaaa6986837fbfa8903a7b2196';
const pools = (n: number) => Array.from({ length: n }, (_, i) => ({ pool: `Pool ${String.fromCharCode(65 + i)}`, connections: ['a'], templates: 2 }));
const ep = (o: Partial<Episode> = {}): Episode => ({
  parent: PARENT, height: 900_001, heights: [900_001], pools: pools(9), first_ms: 0, last_ms: 76_000, duration_ms: 76_000,
  templates: 24, auxpow_templates: 0, auxpow_share: 0, kind: 'stale', invalid_coinbase: null,
  facts: {
    tip_at_first: 900_000, tip_at_last: 900_000, tip_offset: 0, nbits: [], bitcoin_bits: null, bitcoin_bits_at: null,
    bitcoin_difficulty: true, pow_ok: true, pow_bits: '', in_stale_blocks: true, stale_block: { height: 900_000, header_source: null, miner: 'Pool Z' },
  },
  ...o,
});
const blocks: CardBlock[] = [
  { block_hash: 'aa'.repeat(31) + '0001', height: 900_000, best: true, miner: 'Pool Y' },
  { block_hash: 'bb'.repeat(31) + '0002', height: 900_001, best: true, miner: null },
  { block_hash: 'cc'.repeat(32), height: 900_000, best: false, miner: 'Pool Z' },
];

describe('text pieces', () => {
  it('lists names as the page does', () => {
    expect(nameList(['Pool A', 'Pool B', 'Pool C', 'Pool D', 'Pool E', 'Pool F'])).toBe('Pool A, Pool B, Pool C, Pool D +2');
    expect(nameList(['Pool A', 'Pool B'])).toBe('Pool A, Pool B');
    expect(shortHash(PARENT)).toBe('0000…7b2196');
    expect(headerHash(PARENT)).toBe('000000…7b2196');
    expect(fitName('A very long pool name')).toBe('A very long p…');
    expect(fitName('Short')).toBe('Short');
  });
});

describe('cardModel', () => {
  it('a race: our blocks with their miners (a hash when none), the stale block below with its miner, the pools beside', () => {
    const m = cardModel(ep(), blocks);
    expect(m.tiles).toEqual([
      { col: 1, row: 0, label: '900,000', sub: 'Pool Y', style: 'strip' },
      { col: 0, row: 0, label: '900,001', sub: 'bbbb…bb0002', style: 'strip' },
      { col: 1, row: 1, label: '900,000', sub: 'Pool Z', style: 'stale' },
    ]);
    expect(m).toMatchObject({ link: true, ourTip: false, hash: '000000…7b2196', builtOn: '← 9 pools built on it',
      pools: 'Pool A, Pool B, Pool C, Pool D +5', invalidCoinbase: null, facts: 'for 76s · 24 templates' });
  });
  it('a stale block whose miner is an excluded pool (null in the facts) shows its hash, as on the page', () => {
    const e = ep();
    e.facts.stale_block = { height: 900_000, header_source: null, miner: null };
    expect(cardModel(e, blocks).tiles[2]).toMatchObject({ sub: '0000…7b2196', style: 'stale' });
  });
  it('an unknown parent at our tip: a dashed outline with its hash; no blocks read: heights only', () => {
    const m = cardModel(ep({ kind: 'invalid_parent', pools: pools(1) }), null);
    expect(m.tiles).toEqual([
      { col: 1, row: 0, label: '900,000', sub: '', style: 'strip' },
      { col: 0, row: 0, label: '900,001', sub: '', style: 'strip' },
      { col: 1, row: 1, label: '900,000', sub: '0000…7b2196', style: 'outline' },
    ]);
    expect(m.builtOn).toBe('← 1 pool built on it');
  });
  it('another chain far from our tip: our tip, and the parent under it', () => {
    const e = ep({ kind: 'other_chain', height: 59_398, pools: pools(1) });
    e.facts.tip_at_first = 967_373;
    const m = cardModel(e, []);
    expect(m.tiles).toEqual([
      { col: 0, row: 0, label: '967,373', sub: '', style: 'strip' },
      { col: 0, row: 1, label: '59,397', sub: '0000…7b2196', style: 'outline' },
    ]);
    expect(m).toMatchObject({ link: false, ourTip: true });
  });
  it('an invalid coinbase: our block outlined, no parent; a race with one names the offenders', () => {
    const m = cardModel(ep({ kind: 'invalid_coinbase', pools: pools(2), templates: 3 }), blocks);
    expect(m.tiles.map(t => t.style)).toEqual(['strip', 'overpaid']);
    expect(m).toMatchObject({ builtOn: '2 pools overpaid the coinbase', facts: '3 templates', link: false, ourTip: false });
    const race = cardModel(ep({ invalid_coinbase: { height: 900_001, pools: [
      { pool: 'Pool A', templates: 1, total_sats: 1, subsidy_sats: 1 }, { pool: 'Pool B', templates: 1, total_sats: 1, subsidy_sats: 1 },
    ] } }), blocks);
    expect(race.invalidCoinbase).toBe('✗ invalid coinbase: Pool A, Pool B');
  });
});
