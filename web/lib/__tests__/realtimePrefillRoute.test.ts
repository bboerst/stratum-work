/**
 * /api/realtime-prefill against mocked database functions: the blacklist (POOL_BLACKLIST, read at import like the
 * stream route) applies to pre-filled rows, and with ENABLE_HISTORICAL_DATA=false the database isn't touched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const NOW_MS = Date.now();
const usHex = (ms: number) => (BigInt(ms) * BigInt(1_000_000)).toString(16);

async function loadRoute({ historical, blacklist }: { historical: boolean; blacklist: string }) {
  vi.resetModules();
  vi.stubEnv('POOL_BLACKLIST', blacklist);
  const getHighestBlock = vi.fn(async () => ({ height: 100, timestamp: Math.floor((NOW_MS - 60_000) / 1000) }));
  const fetchMiningNotifyAtHeights = vi.fn(async (from: number, to: number) => [from, to].flatMap(height => [
    { pool_name: 'Public', timestamp: usHex(NOW_MS - 1000), height },
    { pool_name: 'Private', timestamp: usHex(NOW_MS - 1000), height },
  ]));
  vi.doMock('../db/blocks', () => ({ enableHistoricalData: historical, getHighestBlock }));
  vi.doMock('../db/mining-notify', () => ({ fetchMiningNotifyAtHeights }));
  const route = await import('../../app/api/realtime-prefill/route');
  return { route, getHighestBlock, fetchMiningNotifyAtHeights };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('../db/blocks');
  vi.doUnmock('../db/mining-notify');
});

describe('GET /api/realtime-prefill', () => {
  it('reads tip + 1 and the two heights before it in one statement, with blacklisted pools filtered out', async () => {
    const { route, fetchMiningNotifyAtHeights } = await loadRoute({ historical: true, blacklist: 'Private' });
    const body = await (await route.GET()).json();
    expect(body.enabled).toBe(true);
    expect(body.tip.height).toBe(100);
    expect(body.heights).toEqual([101, 100, 99]);
    expect(fetchMiningNotifyAtHeights.mock.calls).toEqual([[99, 101]]);
    expect(new Set(body.templates.map((t: { pool_name: string }) => t.pool_name))).toEqual(new Set(['Public']));
  });

  it('shares one database read between requests within the cache period', async () => {
    const { route, getHighestBlock } = await loadRoute({ historical: true, blacklist: '' });
    await route.GET();
    await route.GET();
    expect(getHighestBlock).toHaveBeenCalledTimes(1);
  });

  it('touches no database when historical data is disabled', async () => {
    const { route, getHighestBlock, fetchMiningNotifyAtHeights } = await loadRoute({ historical: false, blacklist: '' });
    const body = await (await route.GET()).json();
    expect(body).toEqual({ enabled: false, tip: null, heights: [], templates: [] });
    expect(getHighestBlock).not.toHaveBeenCalled();
    expect(fetchMiningNotifyAtHeights).not.toHaveBeenCalled();
  });
});
