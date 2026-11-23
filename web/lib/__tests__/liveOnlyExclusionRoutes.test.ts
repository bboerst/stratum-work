/**
 * POOL_BLACKLIST hides live work only: these analysis routes keep an excluded pool at a mined height (at or below our
 * tip) and leave it out above the tip, or everywhere while the tip is unknown (fail closed). Mocked reads; the real
 * database version is pgExclusionInvariant.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const TIP = 100_000;

async function load(route: string, tip: number | null, blacklist = 'Hidden') {
  vi.resetModules();
  vi.stubEnv('POOL_BLACKLIST', blacklist);
  vi.stubEnv('EXTRANONCE1_MASK_KEY', 'live-only-key');
  const notify = (pool: string) => ({ pool_name: pool, height: 0, job_id: `j-${pool}`, timestamp: '1000', extranonce1: 'c0ffee01',
    coinbase1: '', coinbase2: '', merkle_branches: [], version: '20000000', nbits: '17034219', ntime: '66000000', clean_jobs: true });
  vi.doMock('../db/blocks', () => ({ enableHistoricalData: true, getHighestBlock: vi.fn(async () => (tip === null ? null : { height: tip })) }));
  vi.doMock('../db/mining-notify', () => ({
    getMiningNotifyByHeight: vi.fn(async () => [notify('P'), notify('Hidden')]),
    getFirstSeenByPool: vi.fn(async () => [{ poolName: 'P', timestamp: 1 }, { poolName: 'Hidden', timestamp: 2 }]),
    getPoolNamesAtHeight: vi.fn(async () => ['P', 'Hidden']),
  }));
  vi.doMock('../db/pools', () => ({ getAllPools: vi.fn(async () => [{ id: 1, name: 'P' }, { id: 2, name: 'Hidden' }]) }));
  const m = await import(`../../app/api/${route}/route`);
  return async (qs = '') => {
    const res: Response = await m.GET(new NextRequest(`http://test/api/${route}${qs}`));
    return { status: res.status, body: await res.json() };
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const p of ['../db/blocks', '../db/mining-notify', '../db/pools']) vi.doUnmock(p);
});

const pools = (rows: { pool_name?: string; poolName?: string; name?: string }[]) => rows.map(r => r.pool_name ?? r.poolName ?? r.name);

describe('POOL_BLACKLIST is live-only', () => {
  for (const [route, key] of [['mining-notify', 'pool_name'], ['block-pool-first-seen', 'poolName']] as const) {
    it(`/api/${route}: keeps the pool at or below our tip, leaves it out above it or with no tip (${key})`, async () => {
      const get = await load(route, TIP);
      expect(pools((await get(`?height=${TIP}`)).body)).toEqual(['P', 'Hidden']);
      expect(pools((await get(`?height=${TIP - 500}`)).body)).toEqual(['P', 'Hidden']);
      expect(pools((await get(`?height=${TIP + 1}`)).body)).toEqual(['P']);
      const blind = await load(route, null);
      expect(pools((await blind(`?height=${TIP - 500}`)).body)).toEqual(['P']);
    });
  }

  it('/api/pools: every pool definition (reference data, not live work)', async () => {
    const get = await load('pools', TIP);
    expect(pools((await get()).body)).toEqual(['P', 'Hidden']);
  });
});
