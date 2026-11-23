import { describe, expect, it } from 'vitest';
import { buildRuns, coinbaseTotal, isInvalidWork } from '../forkLanes';
import type { LaneTemplateSql } from '../db/fork-lanes';

// A coinbase paying 3.25 BTC (one output), with a 4-byte extranonce2 between coinbase1 and coinbase2.
const CB1 = '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff0c0340420f';
// sequence, one output of 0x135fd740 = 325,048,128 sat to OP_TRUE, locktime
const CB2 = 'ffffffff' + '01' + '40d75f1300000000' + '0151' + '00000000';
const PAID = coinbaseTotal(CB1, 'aabbccdd', 4, CB2);
const SUBSIDY = 312_500_000;

const t = (pool: string, us: number, parent: string, o: Partial<LaneTemplateSql> = {}): LaneTemplateSql => ({
  pool, at_us: String(us), parent, nbits: '386000000', version: '536870912', empty: false,
  coinbase1: null, extranonce1: null, coinbase2: null, extranonce2_length: null, ...o,
});
const bad = (pool: string, us: number, parent: string) => t(pool, us, parent, { empty: true, coinbase1: CB1, extranonce1: 'aabbccdd', coinbase2: CB2, extranonce2_length: 4 });

describe('coinbaseTotal (the finding\'s reassembly rule)', () => {
  it('reads what the coinbase pays with the stored extranonce2 length', () => {
    expect(PAID).toBe(325_048_128);
  });
  it('falls back to the one other length that parses, as the backend does when the stored one is wrong', () => {
    expect(coinbaseTotal(CB1, 'aabbccdd', 8, CB2)).toBe(PAID);
  });
  it('gives up rather than guess when nothing parses', () => {
    expect(coinbaseTotal('00', '', 4, '00')).toBeNull();
  });
});

describe('isInvalidWork', () => {
  const finding = new Map([['A', SUBSIDY]]);
  it('only an empty template of a pool the finding names, paying more than the subsidy', () => {
    expect(isInvalidWork(bad('A', 1, 'p'), finding)).toBe(true);
    expect(isInvalidWork(bad('B', 1, 'p'), finding)).toBe(false);                  // not in the finding
    expect(isInvalidWork({ ...bad('A', 1, 'p'), empty: false }, finding)).toBe(false);
    expect(isInvalidWork(bad('A', 1, 'p'), new Map([['A', PAID!]]))).toBe(false);  // not above the subsidy
  });
});

describe('buildRuns', () => {
  it('starts a run where a pool\'s parent or invalidity changes, and only there', () => {
    const r = buildRuns([
      t('A', 1_000_000, 'p'), t('B', 1_500_000, 'q'), bad('A', 2_000_000, 'p'), bad('A', 3_000_000, 'p'),
      t('A', 4_000_000, 'p'), t('A', 5_000_000, 'q'), t('B', 9_000_000, 'q'),
    ], new Map([['A', SUBSIDY]]));
    expect(r.hashes).toEqual(['p', 'q']);
    expect(r.from_ms).toBe(1000);
    expect(r.last_ms).toBe(8000);
    expect(r.lanes).toEqual([
      { pool: 'A', runs: [[0, 0, 0], [1000, 0, 1], [3000, 0, 0], [4000, 1, 0]], end: 4000 },
      { pool: 'B', runs: [[500, 1, 0]], end: 8000 },
    ]);
  });
  it('is empty without templates', () => {
    expect(buildRuns([], new Map()).lanes).toEqual([]);
  });
});
