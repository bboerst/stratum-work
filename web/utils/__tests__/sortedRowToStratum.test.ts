import { describe, expect, test } from 'vitest';
import { sortedRowToStratum } from '../sortedRowToStratum';
import type { SortedRow } from '@/types/tableTypes';

describe('sortedRowToStratum (height page: table rows back to templates for the timing chart)', () => {
  test('keeps what change detection orders and compares by', () => {
    const row = {
      pool_name: 'P', timestamp: 'adjusted', raw_timestamp: '18e750a5ee035e00', received_timestamp: '18e750a5ee036000',
      source_id: 3, site: undefined, replica: undefined, job_id: 'j', height: 1, prev_hash: '00', version: '20000000',
      coinbase1: '', coinbase2: '', extranonce1: '', extranonce2_length: 8, clean_jobs: false, first_transaction: '',
      fee_rate: 0, merkle_branches: [], coinbaseRaw: '', coinbaseScriptASCII: '', coinbaseOutputValue: 0,
      feeRateComputed: 0, coinbase_outputs: [],
    } as unknown as SortedRow;
    const t = sortedRowToStratum(row);
    expect(t.timestamp).toBe('18e750a5ee035e00'); // the raw (first-seen) time, not the latency-adjusted one
    expect(t.received_timestamp).toBe('18e750a5ee036000');
    expect(t.source_id).toBe(3);
  });
});
