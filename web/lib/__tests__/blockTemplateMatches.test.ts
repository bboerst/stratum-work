import { describe, expect, it } from 'vitest';
import { blockMatches, coinbaseFit, matchTimeMs } from '../blockTemplateMatches';
import type { MatchBlockSql, MatchRowSql } from '../db/block-template-matches';

const H = 'aa'.repeat(32);
const block = (o: Partial<MatchBlockSql> = {}): MatchBlockSql =>
  ({ block_hash: H, pool: 'Miner', seen_ms: '1000000', branches: 3, coinbase_known: true, ...o });
const row = (o: Partial<MatchRowSql> = {}): MatchRowSql => ({
  block_hash: H, pool: 'P', conn: 1, source_id: 1, first_us: '999000000', n_rows: '2', branches: 3, match_depth: 3,
  full_match: true, coinbase_prefix: true, coinbase_suffix: true, coinbase_layout: true, ...o,
});

describe('coinbaseFit', () => {
  it('brackets > layout > set only; null without the block\'s coinbase bytes', () => {
    expect(coinbaseFit(row(), true)).toBe('coinbase');
    expect(coinbaseFit(row({ coinbase_prefix: false }), true)).toBe('layout');
    expect(coinbaseFit(row({ coinbase_prefix: false, coinbase_layout: false }), true)).toBe('merkle');
    expect(coinbaseFit(row({ coinbase_prefix: null, coinbase_suffix: null, coinbase_layout: null }), false)).toBeNull();
    expect(coinbaseFit(row(), false)).toBeNull();
  });
});

describe('blockMatches', () => {
  it('verified: every full match, by first receive time, with that copy\'s own latency and a connection label', () => {
    const rows = [
      row({ pool: 'B', conn: 2, source_id: 7, first_us: '999500000', coinbase_prefix: false, coinbase_layout: false }),
      row({ pool: 'A', conn: 1, source_id: 3, first_us: '999100000' }),
      row({ pool: 'C', full_match: false, match_depth: 2 }),                     // partial: not listed when verified
    ];
    const [b] = blockMatches([block()], rows, [
      { source_id: 3, at_us: '999100000', latency_ms: 12.5, latency_method: 'tcp' },
      { source_id: 7, at_us: '1', latency_ms: 99, latency_method: 'tcp' },         // another receive time: not B's
    ]);
    expect(b.state).toBe('verified');
    expect(b.matches).toEqual([
      { pool: 'A', connection: 'a', first_us: '999100000', lat_ms: 12.5, lat_m: 'tcp', templates: 2, coinbase: 'coinbase' },
      { pool: 'B', connection: 'b', first_us: '999500000', lat_ms: null, lat_m: null, templates: 2, coinbase: 'merkle' },
    ]);
    expect(b).toMatchObject({ pool: 'Miner', seen_ms: 1_000_000, closest: null, transactions_known: true });
  });

  it('a full match needs the block\'s branch count (a template with extra branches is not the block\'s set)', () => {
    const [b] = blockMatches([block()], [row({ branches: 4 })], []);
    expect(b.state).toBe('no_match');
  });

  it('no_match: the closest depth as transactions, with its pools', () => {
    const [b] = blockMatches([block()], [
      row({ pool: 'X', full_match: false, match_depth: 2 }), row({ pool: 'W', full_match: false, match_depth: 2, conn: 2 }),
      row({ pool: 'V', full_match: false, match_depth: 1 }),
    ], []);
    expect(b).toMatchObject({ state: 'no_match', matches: [], closest: { depth: 2, transactions: 3, pools: ['W', 'X'] } });
    expect(blockMatches([block()], [], [])[0]).toMatchObject({ state: 'no_match', closest: null });
  });

  it('empty block proves nothing; a block without its merkle path is unknown', () => {
    expect(blockMatches([block({ branches: 0 })], [row({ branches: 0 })], [])[0]).toMatchObject({ state: 'empty_block', matches: [] });
    expect(blockMatches([block({ branches: null })], [row()], [])[0]).toMatchObject({ state: 'unknown', transactions_known: false });
  });

  it('keeps each block\'s own rows apart', () => {
    const other = 'bb'.repeat(32);
    const out = blockMatches([block(), block({ block_hash: other })], [row(), row({ block_hash: other, full_match: false, match_depth: 1 })], []);
    expect(out.map(b => b.state)).toEqual(['verified', 'no_match']);
  });
});

describe('matchTimeMs', () => {
  it('subtracts the copy\'s own latency only when adjusted and known', () => {
    expect(matchTimeMs({ first_us: '1000000', lat_ms: 10 }, true)).toBe(990);
    expect(matchTimeMs({ first_us: '1000000', lat_ms: 10 }, false)).toBe(1000);
    expect(matchTimeMs({ first_us: '1000000', lat_ms: null }, true)).toBe(1000);
  });
});
