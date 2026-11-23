import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('POOL_BLACKLIST', 'HiddenPool');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('../db/blocks');
  vi.doUnmock('../db/mining-notify');
  vi.doUnmock('../db/unknown-parents');
});

describe('/api/analysis-data blocks (the fork timeline arrival markers)', () => {
  it('serves the blocks at h - 1 and h, seen_ms only when a seen time was recorded', async () => {
    const getDrillBlocks = vi.fn(async () => [
      { block_hash: 'aa'.repeat(32), height: 99, arrival_ms: '1000', seen: true, stale_only: false, best: true, miner: 'PoolA', header_ms: '900' },
      { block_hash: 'bb'.repeat(32), height: 99, arrival_ms: '1200', seen: true, stale_only: true, best: false, miner: null },
      { block_hash: 'cc'.repeat(32), height: 100, arrival_ms: '5000', seen: false, stale_only: false, best: true, miner: null },
    ]);
    vi.doMock('../db/blocks', () => ({ getBlockByHeight: vi.fn(async () => null), getInterestingBlocks: vi.fn(async () => []),
      getHighestBlock: vi.fn(async () => ({ height: 100 })), knownBlockHashes: vi.fn(async () => new Set()) }));
    vi.doMock('../db/mining-notify', () => ({ getAllMiningNotifyAtHeight: vi.fn(async () => []) }));
    vi.doMock('../db/unknown-parents', () => ({ getDrillBlocks }));
    const { GET } = await import('../../app/api/analysis-data/route');
    const body = await (await GET(new NextRequest('http://test/api/analysis-data?height=100'))).json();
    expect(getDrillBlocks).toHaveBeenCalledWith(100);
    expect(body.results[0].blocks).toEqual([
      { hash: 'aa'.repeat(32), height: 99, best: true, miner: 'PoolA', seen_ms: 1000, stale_only: false, header_ms: 900 },
      { hash: 'bb'.repeat(32), height: 99, best: false, miner: null, seen_ms: 1200, stale_only: true, header_ms: null },
      { hash: 'cc'.repeat(32), height: 100, best: true, miner: null, seen_ms: null, stale_only: false, header_ms: null },
    ]);
  });

  it('a failed blocks read leaves the markers out, not the height', async () => {
    vi.doMock('../db/blocks', () => ({ getBlockByHeight: vi.fn(async () => null), getInterestingBlocks: vi.fn(async () => []),
      getHighestBlock: vi.fn(async () => ({ height: 100 })), knownBlockHashes: vi.fn(async () => new Set()) }));
    vi.doMock('../db/mining-notify', () => ({ getAllMiningNotifyAtHeight: vi.fn(async () => []) }));
    vi.doMock('../db/unknown-parents', () => ({ getDrillBlocks: vi.fn(async () => { throw new Error('down'); }) }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { GET } = await import('../../app/api/analysis-data/route');
    const res = await GET(new NextRequest('http://test/api/analysis-data?height=100'));
    expect(res.status).toBe(200);
    expect((await res.json()).results[0].blocks).toEqual([]);
  });
});
