import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { insertRouting, insertShares, insertTemplates, isValidTemplateRow, prepareDelivery, templateRowProblem } from '../db.js';
import { toRawMessage } from '../message.js';
import { computeMid } from '../mid.js';
import { messageToTemplateRow, type TemplateRow } from '../serialize.js';

const ts = '18a5c3d2e1f00000';
const template = {
  _id: 'x', timestamp: ts, pool_name: 'AntPool', height: 915000, job_id: 'abc', prev_hash: '00'.repeat(32),
  coinbase1: '01', coinbase2: '02', merkle_branches: ['aa'], version: '20000000', nbits: '17034219', ntime: '66f5a000',
  clean_jobs: true, extranonce1: 'deadbeef', extranonce2_length: 8,
};
const share = {
  type: 'share', timestamp: ts, pool_name: 'AntPool', site: 'us-ash-1', connection_id: 'us-ash-1/AntPool/work',
  job_id: 'abc', share_difficulty: 1024, pool_difficulty: 512, accepted: true, reject_reason: null, response_ms: 12.5,
};
const routing = { type: 'routing', timestamp: ts, site: 'us-ash-1', active: 'AntPool' };

const buf = (o: unknown) => Buffer.from(JSON.stringify(o));
const rowOf = (o: Record<string, unknown>): TemplateRow => messageToTemplateRow(toRawMessage(buf(o), 1)!);

describe('templateRowProblem / isValidTemplateRow', () => {
  it('accepts a complete legacy template', () => {
    const row = rowOf(template);
    expect(templateRowProblem(row)).toBeNull();
    expect(isValidTemplateRow(row)).toBe(true);
  });
  it.each(['height', 'prev_hash', 'version', 'coinbase1', 'coinbase2', 'extranonce2_length'])('rejects a row missing %s', (field) => {
    const doc: Record<string, unknown> = { ...template };
    delete doc[field];
    const row = rowOf(doc);
    expect(isValidTemplateRow(row)).toBe(false);
    expect(templateRowProblem(row)).toContain(field);
  });
  it('rejects non-integer or out-of-range height', () => {
    expect(isValidTemplateRow({ ...rowOf(template), height: 1.5 })).toBe(false);
    expect(isValidTemplateRow({ ...rowOf(template), height: 2 ** 31 })).toBe(false);
    expect(isValidTemplateRow({ ...rowOf(template), height: '915000' as unknown as number })).toBe(false);
  });
  it('rejects merkle_branches that are not a string array', () => {
    expect(isValidTemplateRow({ ...rowOf(template), merkle_branches: 'aa' as unknown as string[] })).toBe(false);
    expect(isValidTemplateRow({ ...rowOf(template), merkle_branches: [1] as unknown as string[] })).toBe(false);
  });
  it('rejects a bad mid, ts or ts_ns', () => {
    expect(isValidTemplateRow({ ...rowOf(template), mid: Buffer.alloc(4) })).toBe(false);
    expect(isValidTemplateRow({ ...rowOf(template), ts: new Date(NaN) })).toBe(false);
    expect(isValidTemplateRow({ ...rowOf(template), ts_ns: (2n ** 63n).toString() })).toBe(false);
  });
  it('rejects a non-numeric lat_ms', () => {
    expect(isValidTemplateRow({ ...rowOf(template), lat_ms: 'fast' as unknown as number })).toBe(false);
  });
});

describe('prepareDelivery', () => {
  it('turns a valid template into a template row item', () => {
    const r = prepareDelivery(buf(template), 1);
    expect('item' in r && r.item.kind).toBe('template');
    if ('item' in r && r.item.kind === 'template') expect(r.item.row.pool).toBe('AntPool');
  });
  it('passes valid share and routing messages through', () => {
    const s = prepareDelivery(buf(share), 1);
    const r = prepareDelivery(buf(routing), 1);
    expect('item' in s && s.item.kind).toBe('share');
    expect('item' in r && r.item.kind).toBe('routing');
  });
  it('drops unparseable JSON with the body mid', () => {
    const body = Buffer.from('{not json');
    expect(prepareDelivery(body, 1)).toMatchObject({ drop: 'unparseable', mid: computeMid(body) });
    expect(prepareDelivery(Buffer.from('42'), 1)).toMatchObject({ drop: 'unparseable' });
  });
  it('drops unsupported kinds', () => {
    expect(prepareDelivery(buf({ type: 'block', id: 'x' }), 1)).toMatchObject({ drop: 'unsupported_kind' });
    expect(prepareDelivery(buf({ hello: 1 }), 1)).toMatchObject({ drop: 'unsupported_kind' });
  });
  it('drops templates missing a NOT NULL column', () => {
    for (const field of ['height', 'job_id', 'version', 'coinbase1', 'coinbase2', 'extranonce2_length', 'timestamp']) {
      const doc: Record<string, unknown> = { ...template };
      delete doc[field];
      expect(prepareDelivery(buf(doc), 1)).toMatchObject({ drop: 'invalid_template' });
    }
  });
  it('drops templates with a non-hex timestamp instead of throwing', () => {
    expect(prepareDelivery(buf({ ...template, timestamp: 'zz' }), 1)).toMatchObject({ drop: 'invalid_template' });
  });
  it('drops shares missing required fields or with non-numeric difficulties', () => {
    for (const field of ['timestamp', 'pool_name', 'site', 'connection_id']) {
      const doc: Record<string, unknown> = { ...share };
      delete doc[field];
      expect(prepareDelivery(buf(doc), 1)).toMatchObject({ drop: 'invalid_share' });
    }
    expect(prepareDelivery(buf({ ...share, share_difficulty: 'big' }), 1)).toMatchObject({ drop: 'invalid_share' });
  });
  it('drops routing messages without site or with a bad timestamp', () => {
    expect(prepareDelivery(buf({ ...routing, site: undefined }), 1)).toMatchObject({ drop: 'invalid_routing' });
    expect(prepareDelivery(buf({ ...routing, timestamp: 'nope' }), 1)).toMatchObject({ drop: 'invalid_routing' });
  });
  it('drops messages containing NUL characters, which Postgres text/jsonb reject', () => {
    expect(prepareDelivery(buf({ ...template, coinbase1: 'a\u0000b' }), 1)).toMatchObject({ drop: 'invalid_template' });
    expect(prepareDelivery(buf({ ...routing, note: '\u0000' }), 1)).toMatchObject({ drop: 'invalid_routing' });
  });
  it('does not include the message body in the drop detail', () => {
    const r = prepareDelivery(buf({ ...template, height: undefined, coinbase1: 'SECRETISH' }), 1);
    expect('detail' in r && r.detail).not.toContain('SECRETISH');
  });
});

function fakePool(rowCount = (n: number) => n) {
  const query = vi.fn(async (q: { text: string; values: unknown[] }) => ({ rowCount: rowCount(q.values.length) }));
  return { pool: { query } as unknown as pg.Pool, query };
}

describe('insert functions (fake pool)', () => {
  it('insertTemplates issues ON CONFLICT DO NOTHING and returns rowCount', async () => {
    const { pool, query } = fakePool(() => 1);
    expect(await insertTemplates(pool, [rowOf(template)])).toBe(1);
    const q = query.mock.calls[0][0];
    expect(q.text).toMatch(/^INSERT INTO templates \(ts,ts_ns,mid,/);
    expect(q.text).toMatch(/ON CONFLICT \(mid, ts\) DO NOTHING$/);
    expect(q.values).toHaveLength(26);
  });
  it('insertTemplates returns 0 without querying for no rows', async () => {
    const { pool, query } = fakePool();
    expect(await insertTemplates(pool, [])).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
  it('insertTemplates serialises extra as JSON', async () => {
    const { pool, query } = fakePool();
    await insertTemplates(pool, [rowOf({ ...template, future: { x: 1 } })]);
    expect(query.mock.calls[0][0].values[25]).toBe('{"future":{"x":1}}');
  });
  it('insertTemplates splits batches that would exceed the 65535 parameter limit', async () => {
    const { pool, query } = fakePool(() => 7);
    const rows = Array.from({ length: 3000 }, () => rowOf(template));
    expect(await insertTemplates(pool, rows)).toBe(7 * query.mock.calls.length);
    expect(query.mock.calls.length).toBe(2);
    for (const [q] of query.mock.calls) expect(q.values.length).toBeLessThanOrEqual(65535);
  });
  it('insertShares maps share fields to columns', async () => {
    const { pool, query } = fakePool(() => 1);
    const raw = toRawMessage(buf(share), 1)!;
    expect(await insertShares(pool, [raw])).toBe(1);
    const [q] = query.mock.calls[0];
    expect(q.text).toMatch(/^INSERT INTO shares \(ts,mid,connection_id,pool,site,job_id,share_difficulty,pool_difficulty,accepted,reject_reason,response_ms\)/);
    expect(q.values[0]).toEqual(new Date(Number(BigInt('0x' + ts) / 1_000_000n)));
    expect((q.values[1] as Buffer).toString('hex')).toBe(raw.mid);
    expect(q.values.slice(2)).toEqual(['us-ash-1/AntPool/work', 'AntPool', 'us-ash-1', 'abc', 1024, 512, true, null, 12.5]);
  });
  it('insertRouting stores the whole message as status', async () => {
    const { pool, query } = fakePool(() => 1);
    const raw = toRawMessage(buf(routing), 1)!;
    await insertRouting(pool, [raw]);
    const [q] = query.mock.calls[0];
    expect(q.text).toMatch(/^INSERT INTO routing \(ts,mid,site,status\)/);
    expect(q.values[2]).toBe('us-ash-1');
    expect(JSON.parse(q.values[3] as string)).toEqual(routing);
  });
});
