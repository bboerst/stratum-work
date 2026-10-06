import { describe, expect, it } from 'vitest';
import { templateRowToDoc, blockRowToDoc, TemplateRow } from '../rows';

const row: TemplateRow = { ts: new Date(1), ts_ns: String(BigInt('0x18a5c3d2e1f00000')), mid: Buffer.from('00ff', 'hex'), doc_id: null, pool: 'AntPool', connection_id: 'AntPool', site: 'us-ash-legacy', mode: 'observe', account: null, endpoint_ip: null, height: 1, prev_hash: 'p', job_id: 'j', version: 'v', nbits: 'n', ntime: 't', clean_jobs: true, coinbase1: 'a', coinbase2: 'b', extranonce1: 'e', extranonce2_length: 8, merkle_branches: ['m'], chain_family: null, lat_ms: 3, lat_m: 'tcp', extra: null };

describe('templateRowToDoc', () => {
  it('produces the legacy mining_notify shape', () => {
    const d = templateRowToDoc(row);
    expect(d).toMatchObject({ id: '00ff', pool_name: 'AntPool', timestamp: '18a5c3d2e1f00000', lat_ms: 3, clean_jobs: true });
    expect(d).not.toHaveProperty('site');
    expect(d).not.toHaveProperty('_id');
    expect(d).not.toHaveProperty('chain_family');
  });

  it('uses doc_id for both _id and id when present', () => {
    const d = templateRowToDoc({ ...row, doc_id: 'abc' });
    expect(d._id).toBe('abc');
    expect(d.id).toBe('abc');
  });

  it('emits connection fields for non-legacy rows and merges extra', () => {
    const d = templateRowToDoc({ ...row, site: 'us-ash-1', connection_id: 'us-ash-1/AntPool/work', mode: 'work', account: 'a.w', chain_family: 'bch', lat_ms: null, extra: { future: 1 } });
    expect(d).toMatchObject({ site: 'us-ash-1', connection_id: 'us-ash-1/AntPool/work', mode: 'work', account: 'a.w', chain_family: 'bch', future: 1 });
    expect(d).not.toHaveProperty('lat_ms');
  });
});

describe('blockRowToDoc', () => {
  it('maps mining_pool to both pool and mining_pool', () => {
    const d = blockRowToDoc({ height: 1, block_hash: 'h', timestamp: '5', mining_pool: { name: 'X' }, analysis: null });
    expect(d).toMatchObject({ id: 'h', height: 1, block_hash: 'h', timestamp: 5, pool: { name: 'X' }, mining_pool: { name: 'X' } });
  });

  it('coerces bigint columns to numbers', () => {
    const d = blockRowToDoc({ height: 2, block_hash: 'h2', timestamp: '7', version: '536870912', nonce: '4294967295', mining_pool: null, analysis: null });
    expect(d.version).toBe(536870912);
    expect(d.nonce).toBe(4294967295);
  });
});
