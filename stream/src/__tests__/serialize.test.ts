import { describe, expect, it } from 'vitest';
import { toRawMessage } from '../message.js';
import { blockRowToMessage, KNOWN_TEMPLATE_KEYS, messageToTemplateRow, templateRowToJson } from '../serialize.js';

const legacy = {
  _id: '3f1c0a7e-1111-4222-8333-944455556666', timestamp: '18a5c3d2e1f00000', pool_name: 'AntPool', height: 915000,
  job_id: 'abc', prev_hash: '00'.repeat(32), coinbase1: '01', coinbase2: '02', merkle_branches: ['aa', 'bb'],
  version: '20000000', nbits: '17034219', ntime: '66f5a000', clean_jobs: true, extranonce1: 'deadbeef',
  extranonce2_length: 8, lat_ms: 12.5, lat_m: 'tcp',
};

describe('template row round trip', () => {
  it('reproduces a legacy document exactly', () => {
    const row = messageToTemplateRow(toRawMessage(Buffer.from(JSON.stringify(legacy)), 1)!);
    expect(row.ts_ns).toBe(BigInt('0x18a5c3d2e1f00000').toString());
    expect(row.connection_id).toBe('AntPool');
    expect(templateRowToJson(row)).toEqual(legacy);
  });
  it('keeps new fields and unknown extras', () => {
    const doc = { ...legacy, site: 'us-ash-1', connection_id: 'us-ash-1/AntPool/work', mode: 'work', account: 'a.w', endpoint_ip: '203.0.113.1', chain_family: 'bch', future_field: { x: 1 } };
    const row = messageToTemplateRow(toRawMessage(Buffer.from(JSON.stringify(doc)), 1)!);
    expect(row.extra).toEqual({ future_field: { x: 1 } });
    expect(templateRowToJson(row)).toEqual(doc);
  });
  it('converts ts to a Date at millisecond precision', () => {
    const row = messageToTemplateRow(toRawMessage(Buffer.from(JSON.stringify(legacy)), 1)!);
    expect(row.ts.getTime()).toBe(Number(BigInt('0x18a5c3d2e1f00000') / 1_000_000n));
  });
});

describe('template row columns', () => {
  it('fills legacy defaults and stores mid as 16 raw bytes', () => {
    const msg = toRawMessage(Buffer.from(JSON.stringify(legacy)), 1)!;
    const row = messageToTemplateRow(msg);
    expect(row.mid).toBeInstanceOf(Buffer);
    expect(row.mid.length).toBe(16);
    expect(row.mid.toString('hex')).toBe(msg.mid);
    expect(row.site).toBe('us-ash-legacy');
    expect(row.mode).toBe('observe');
    expect(row.pool).toBe('AntPool');
    expect(row.doc_id).toBe(legacy._id);
    expect(row.extra).toBeNull();
    expect(row.account).toBeNull();
    expect(row.endpoint_ip).toBeNull();
    expect(row.chain_family).toBeNull();
  });
  it('coerces numeric job_id to string and string clean_jobs to boolean', () => {
    const doc = { ...legacy, job_id: 42, clean_jobs: 'true' };
    const row = messageToTemplateRow(toRawMessage(Buffer.from(JSON.stringify(doc)), 1)!);
    expect(row.job_id).toBe('42');
    expect(row.clean_jobs).toBe(true);
  });
  it('lists every known collector key', () => {
    for (const k of Object.keys(legacy)) expect(KNOWN_TEMPLATE_KEYS).toContain(k);
    for (const k of ['site', 'connection_id', 'mode', 'account', 'endpoint_ip', 'chain_family']) expect(KNOWN_TEMPLATE_KEYS).toContain(k);
  });
});

describe('blockRowToMessage', () => {
  it('builds a block stream message from a blocks row', () => {
    const msg = blockRowToMessage({ block_hash: 'ff'.repeat(32), height: 915000, timestamp: '1727550000', mining_pool: { name: 'AntPool' }, analysis: { flags: [] } });
    const iso = new Date(1727550000 * 1000).toISOString();
    expect(msg).toEqual({
      type: 'block', id: 'ff'.repeat(32), timestamp: iso,
      data: { hash: 'ff'.repeat(32), height: 915000, timestamp: iso, mining_pool: { name: 'AntPool' }, analysis: { flags: [] } },
    });
  });
});
