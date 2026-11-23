/**
 * /api/forks/timeline against mocked reads: it serves only heights an episode of all history claims (other chains'
 * aside), reads them over the episodes' span with the excluded pools, and keeps one read per height.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

type Ep = { parent: string; height: number; heights: number[]; kind: string; first_ms: number; last_ms: number };
const ep = (o: Partial<Ep> = {}): Ep => ({ parent: 'ab'.repeat(32), height: 900_001, heights: [900_001], kind: 'stale',
  first_ms: 1000, last_ms: 5000, ...o });

async function loadRoute({ historical = true, episodes = [ep()], final = true } = {}) {
  vi.resetModules();
  delete (globalThis as { __forkLanes?: unknown }).__forkLanes;
  vi.stubEnv('POOL_BLACKLIST', 'Hidden');
  const getSummary = vi.fn(async () => ({ enabled: true, supported: true, episodes }));
  const getForkLanes = vi.fn(async (height: number) => ({ height, pools: [] }));
  const isHeightFinal = vi.fn(async () => final);
  vi.doMock('../db/blocks', () => ({ enableHistoricalData: historical }));
  vi.doMock('../forksSummary', () => ({ getSummary }));
  vi.doMock('../forkLanes', () => ({ getForkLanes }));
  vi.doMock('../db/mining-notify', () => ({ isHeightFinal }));
  const route = await import('../../app/api/forks/timeline/route');
  const get = (qs: string) => route.GET(new Request(`http://localhost/api/forks/timeline${qs}`));
  return { get, getSummary, getForkLanes, isHeightFinal };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const m of ['../db/blocks', '../forksSummary', '../forkLanes', '../db/mining-notify']) vi.doUnmock(m);
});

describe('GET /api/forks/timeline', () => {
  it('touches no database with history disabled', async () => {
    const { get, getSummary } = await loadRoute({ historical: false });
    expect(await (await get('?height=900001')).json()).toEqual({ enabled: false, supported: false });
    expect(getSummary).not.toHaveBeenCalled();
  });

  it('rejects a height that is not a positive integer', async () => {
    const { get, getSummary } = await loadRoute();
    for (const qs of ['', '?height=0', '?height=-1', '?height=1.5', '?height=abc', '?height=1234567890']) {
      expect((await get(qs)).status).toBe(400);
    }
    expect(getSummary).not.toHaveBeenCalled();
  });

  it('404s a height no episode claims, or only another chain does, without reading it', async () => {
    const { get, getForkLanes } = await loadRoute({ episodes: [ep(), ep({ height: 6_976_415, heights: [6_976_415], kind: 'other_chain' })] });
    expect((await get('?height=900002')).status).toBe(404);
    expect((await get('?height=6976415')).status).toBe(404);
    expect(getForkLanes).not.toHaveBeenCalled();
  });

  it('reads a fork height over its episodes\' span with the excluded pools, once per height while cached', async () => {
    const { get, getForkLanes } = await loadRoute({ episodes: [
      ep(), ep({ parent: 'cd'.repeat(32), heights: [900_001, 900_002], height: 900_002, first_ms: 500, last_ms: 9000 }),
    ] });
    const res = await get('?height=900001');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(await res.json()).toEqual({ height: 900_001, pools: [] });
    expect(getForkLanes).toHaveBeenCalledWith(900_001, { fromMs: 500, toMs: 9000 }, ['Hidden']);
    await get('?height=900001');
    expect(getForkLanes).toHaveBeenCalledTimes(1);
  });

  it('caches a height still open briefly, and does not keep a failed read', async () => {
    const { get } = await loadRoute({ final: false });
    expect((await get('?height=900001')).headers.get('Cache-Control')).toBe('public, max-age=15');
    const failing = await loadRoute();
    failing.getForkLanes.mockRejectedValueOnce(new Error('statement timeout'));
    expect((await failing.get('?height=900001')).status).toBe(500);
    expect((await failing.get('?height=900001')).status).toBe(200);
    expect(failing.getForkLanes).toHaveBeenCalledTimes(2);
  });
});
