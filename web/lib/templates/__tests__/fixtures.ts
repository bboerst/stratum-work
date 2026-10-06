import type { RawTemplate } from '../types';
// Coinbase: scriptSig "/test/"; outputs = 312,600,000 sats to bc1qzyg3…h8ffkz + witness commitment.
export const CB1 = '02000000010000000000000000000000000000000000000000000000000000000000000000ffffffff0e2f746573742f';
export const CB2 = 'ffffffff02c0e5a1120000000016001411111111111111111111111111111111111111110000000000000000266a24aa21a9ed222222222222222222222222222222222222222222222222222222222222222200000000';
export const ADDR = 'bc1qzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3h8ffkz';
export const PREV = 'aa'.repeat(32);
let seq = 0;
export function makeRaw(over: Partial<RawTemplate> = {}): RawTemplate {
  seq++;
  return {
    pool_name: 'PoolA', timestamp: (BigInt(1_700_000_000_000 + seq) * BigInt(1_000_000)).toString(16), job_id: `j${seq}`,
    height: 840000, prev_hash: PREV, version: '20000000', coinbase1: CB1, coinbase2: CB2, extranonce1: 'aabbccdd',
    extranonce2_length: 4, clean_jobs: false, first_transaction: '', fee_rate: '', merkle_branches: ['b1', 'b2', 'b3'],
    nbits: '17034219', ntime: '66000000', ...over,
  };
}
export const tsHex = (ms: number) => (BigInt(ms) * BigInt(1_000_000)).toString(16);
