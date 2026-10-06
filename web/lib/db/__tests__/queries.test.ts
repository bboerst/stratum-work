import { beforeEach, describe, expect, it, vi } from 'vitest';
const query = vi.fn();
vi.mock('../pg', () => ({ getPool: () => ({ query }) }));
import { getBlocks, getBlockByHeight, getInterestingBlocks } from '../blocks';
import { getMiningNotifyByHeight, getObserveTemplatesAtHeight, getBlockPoolFirstSeen, getTemplatesInRange } from '../mining-notify';
import { getAllPools, getPoolDefs } from '../pools';

const blockRow = (h: number) => ({ height: h, block_hash: String(h), timestamp: '0', mining_pool: null, analysis: null });
const tplRow = (over: Record<string, unknown> = {}) => ({
  ts: new Date(1), ts_ns: '1000', mid: Buffer.from('0a0b', 'hex'), doc_id: null, pool: 'P', connection_id: 'P', site: 'us-ash-legacy',
  mode: 'observe', account: null, endpoint_ip: null, height: 1, prev_hash: 'p', job_id: 'j', version: 'v', nbits: 'n', ntime: 't',
  clean_jobs: false, coinbase1: 'a', coinbase2: 'b', extranonce1: 'e', extranonce2_length: 4, merkle_branches: [], chain_family: null,
  lat_ms: null, lat_m: null, extra: null, ...over,
});

beforeEach(() => query.mockReset());

describe('getBlocks', () => {
  it('returns has_more and next_height for the default page', async () => {
    query.mockResolvedValueOnce({ rows: [3, 2, 1].map(blockRow) });
    const res = await getBlocks(2);
    expect(res.blocks.map(b => b.height)).toEqual([3, 2]);
    expect(res.has_more).toBe(true);
    expect(res.next_height).toBe(2);
    expect(query.mock.calls[0][0]).toContain('ORDER BY height DESC');
    expect(query.mock.calls[0][1]).toEqual([null, 3]);
  });

  it('passes before as the upper bound', async () => {
    query.mockResolvedValueOnce({ rows: [5, 4].map(blockRow) });
    const res = await getBlocks(2, 5);
    expect(query.mock.calls[0][1]).toEqual([5, 3]);
    expect(res.has_more).toBe(false);
    expect(res.next_height).toBe(4);
  });

  it('after: ascending query, descending result', async () => {
    query.mockResolvedValueOnce({ rows: [11, 12].map(blockRow) });
    const res = await getBlocks(2, undefined, undefined, 10);
    expect(query.mock.calls[0][0]).toContain('ORDER BY height ASC');
    expect(query.mock.calls[0][1]).toEqual([10, 2]);
    expect(res).toMatchObject({ has_more: true, next_height: null });
    expect(res.blocks.map(b => b.height)).toEqual([12, 11]);
  });

  it('height: centered window, fetches the target block if missing', async () => {
    query.mockResolvedValueOnce({ rows: [102, 101].map(blockRow) });
    query.mockResolvedValueOnce({ rows: [blockRow(100)] });
    const res = await getBlocks(4, undefined, 100);
    expect(query.mock.calls[0][1]).toEqual([98, 102, 8]);
    expect(res.blocks.map(b => b.height)).toEqual([102, 101, 100]);
    expect(res).toMatchObject({ has_more: true, next_height: 99 });
  });

  it('formats mining_pool for the frontend', async () => {
    query.mockResolvedValueOnce({ rows: [{ ...blockRow(1), mining_pool: { id: '7', name: 'X', slug: 'x', extra: 1 } }] });
    const res = await getBlocks(1);
    expect(res.blocks[0].mining_pool).toEqual({ id: 7, name: 'X', slug: 'x', tag: undefined, datum_template_creator: undefined, link: undefined, match_type: undefined, identification_method: undefined });
  });
});

describe('getBlockByHeight', () => {
  it('returns null when missing', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await getBlockByHeight(9)).toBeNull();
    expect(query.mock.calls[0][1]).toEqual([9]);
  });
});

describe('getInterestingBlocks', () => {
  it('uses the interesting-analysis filter', async () => {
    query.mockResolvedValueOnce({ rows: [{ height: 1, block_hash: 'h', analysis: { x: 1 }, mining_pool: null }] });
    const items = await getInterestingBlocks(200);
    expect(query.mock.calls[0][0]).toContain("(analysis - 'pool_identification') <> '{}'::jsonb");
    expect(query.mock.calls[0][1]).toEqual([200]);
    expect(items).toEqual([{ height: 1, block_hash: 'h', analysis: { x: 1 }, mining_pool: null }]);
  });
});

describe('getMiningNotifyByHeight', () => {
  it('excludes work-mode and alt-chain rows and caches by height', async () => {
    query.mockResolvedValueOnce({ rows: [tplRow({ height: 777 })] });
    const first = await getMiningNotifyByHeight(777);
    const second = await getMiningNotifyByHeight(777);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("chain_family IS NULL AND mode = 'observe'");
    expect(first).toBe(second);
    expect(first[0]).toMatchObject({ id: '0a0b', pool_name: 'P', timestamp: '3e8', height: 777 });
  });
});

describe('getObserveTemplatesAtHeight', () => {
  it('keeps alt-chain rows but excludes work-mode rows', async () => {
    query.mockResolvedValueOnce({ rows: [tplRow({ chain_family: 'bch' })] });
    const res = await getObserveTemplatesAtHeight(5);
    expect(query.mock.calls[0][0]).toContain("mode = 'observe'");
    expect(query.mock.calls[0][0]).not.toContain('chain_family');
    expect(query.mock.calls[0][1]).toEqual([5]);
    expect(res[0].chain_family).toBe('bch');
  });
});

describe('getBlockPoolFirstSeen', () => {
  it('returns hex timestamps sorted by first-seen time', async () => {
    query.mockResolvedValueOnce({ rows: [{ pool: 'B', ts_ns: '4096', lat_ms: null }, { pool: 'A', ts_ns: '255', lat_ms: 2.5 }] });
    const res = await getBlockPoolFirstSeen(5);
    expect(query.mock.calls[0][0]).toContain('DISTINCT ON (pool)');
    expect(res).toEqual([
      { poolName: 'A', firstSeenTimestamp: 'ff', firstSeenLatencyMs: 2.5 },
      { poolName: 'B', firstSeenTimestamp: '1000', firstSeenLatencyMs: null },
    ]);
  });
});

describe('getTemplatesInRange', () => {
  it('queries the range and maps rows', async () => {
    query.mockResolvedValueOnce({ rows: [tplRow()] });
    const res = await getTemplatesInRange(1000, 2000);
    expect(query.mock.calls[0][1]).toEqual([1000, 2000]);
    expect(res[0].pool_name).toBe('P');
  });

  it('rejects spans over 2 hours', async () => {
    await expect(getTemplatesInRange(0, 2 * 3600_000 + 1)).rejects.toThrow(RangeError);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('getAllPools', () => {
  it('returns the legacy pool shape', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 3, name: 'P', tag: 't', addresses: ['a'] }] });
    expect(await getAllPools()).toEqual([{ id: '3', name: 'P', tag: 't', addresses: ['a'] }]);
  });
});

describe('getPoolDefs', () => {
  it('parses pools.doc into PoolDef', async () => {
    query.mockResolvedValueOnce({ rows: [{ doc: { id: 7, name: 'P', tags: ['/P/'], addresses: ['a'] } }] });
    expect(await getPoolDefs()).toEqual([{ id: '7', name: 'P', tags: ['/P/'], regexes: [], addresses: ['a'] }]);
    expect(query.mock.calls[0][0]).toContain('SELECT doc FROM pools');
  });
});
