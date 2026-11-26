/**
 * /api/off-mempool (#328) against mocked reads: disabled history touches no database, parameter validation, the range
 * bounded by our tip and by the start of the record (never a row below it), the lead-in read below the range, the
 * resync read bounded by the first recorded block, caching (a failure not kept), and one block's positions as runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChainBlock, RecordedBlock } from '../offMempool';

const TIP = 3_020_000;
const hash = (h: number) => h.toString(16).padStart(64, '0');

// one counted epoch; feeds f1 (pool 1) and f2 (pool 2) share a provider; pool 3 is on no feed
const E = Math.floor((TIP - 100) / 2016);
const providerInputs = {
  counted: [{ epoch: E, heights: 2016 }],
  nodes: [{ epoch: E, feed: 'f1', pool_id: 1, sets: 50, templates: 50 }, { epoch: E, feed: 'f2', pool_id: 2, sets: 50, templates: 50 }],
  pairs: [{ epoch: E, feed_a: 'f1', pool_a: 1, feed_b: 'f2', pool_b: 2, shared: 50 }],
  blocks: Array.from({ length: 101 }, (_, i) => ({ height: TIP - 100 + i, pool_id: (i % 3) + 1, pool: `Pool ${(i % 3) + 1}`, creator: null, time_ms: i })),
  poolNames: new Map([[1, 'Pool 1'], [2, 'Pool 2'], [3, 'Pool 3']]),
};

async function loadRoute({ historical = true, recordFrom = TIP - 100 as number | null, tip = TIP as number | null } = {}) {
  vi.resetModules();
  delete (globalThis as { __offMempool?: unknown }).__offMempool;
  const getBestTipHeight = vi.fn(async () => tip);
  const getRecordFrom = vi.fn(async () => recordFrom);
  const getChainBlocks = vi.fn(async (from: number, to: number): Promise<ChainBlock[]> =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ height: from + i, hash: hash(from + i), pool: 'P', time_s: i })));
  const getRecordedBlocks = vi.fn(async (from: number, to: number) => {
    const m = new Map<string, RecordedBlock>();
    for (let h = from; h <= to; h++) m.set(hash(h), { hash: hash(h), seen_ms: h * 1000, tx_count: 11, off_mempool: 2, checked: true });
    return m;
  });
  const getResyncTimes = vi.fn(async (since: number) => { void since; return [] as number[]; });
  const getOffPositions = vi.fn(async (height: number) => { void height; return [1, 2, 3, 9]; });
  vi.doMock('../db/blocks', () => ({ enableHistoricalData: historical }));
  vi.doMock('../db/unknown-parents', async importOriginal => ({ ...(await importOriginal<object>()), getBestTipHeight }));
  const getTemplateProviderInputs = vi.fn(async (ex: string[]) => { void ex; return providerInputs; });
  vi.doMock('../db/template-providers', () => ({ getTemplateProviderInputs }));
  vi.doMock('../db/off-mempool', () => ({ getRecordFrom, getChainBlocks, getRecordedBlocks, getResyncTimes, getOffPositions }));
  const route = await import('../../app/api/off-mempool/route');
  return { route, getTemplateProviderInputs, getBestTipHeight, getRecordFrom, getChainBlocks, getRecordedBlocks, getResyncTimes, getOffPositions };
}
const get = async (route: { GET: (r: Request) => Promise<Response> }, qs = '') => {
  const r = await route.GET(new Request(`http://localhost/api/off-mempool${qs}`));
  return { status: r.status, body: await r.json() };
};

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

describe('/api/off-mempool', () => {
  it('with historical data disabled answers without a database', async () => {
    const m = await loadRoute({ historical: false });
    expect((await get(m.route)).body).toEqual({ enabled: false, supported: false });
    expect(m.getBestTipHeight).not.toHaveBeenCalled();
  });

  it('rejects a bad range or height', async () => {
    const m = await loadRoute();
    expect((await get(m.route, '?range=1y')).status).toBe(400);
    expect((await get(m.route, '?height=abc')).status).toBe(400);
    expect((await get(m.route, '?height=-1')).status).toBe(400);
  });

  it('never returns a row below the start of the record, and reads no lead-in below it', async () => {
    const m = await loadRoute();
    const { body } = await get(m.route);
    expect(body).toMatchObject({ range: '6e', tip_height: TIP, from_height: TIP - 6 * 2016, record_from: TIP - 100, after_gap_blocks: 6 });
    expect(body.rows[0][0]).toBe(TIP - 100);
    expect(body.rows).toHaveLength(101);
    expect(m.getChainBlocks).toHaveBeenCalledWith(TIP - 100, TIP);
    // the record's first blocks are after a gap (its start), then measured: 10 transactions, 2 off-mempool
    expect(body.rows[0].slice(2, 5)).toEqual([10, null, 3]);   // after a gap: no count served
    expect(body.rows[6].slice(2, 5)).toEqual([10, 2, 0]);
  });

  it('reads a lead-in below a range that starts inside the record, and resyncs from its first recorded block', async () => {
    const m = await loadRoute({ recordFrom: TIP - 20_000 });
    const { body } = await get(m.route);
    const from = TIP - 6 * 2016;
    expect(m.getChainBlocks).toHaveBeenCalledWith(from - 6, TIP);
    expect(m.getResyncTimes).toHaveBeenCalledWith((from - 6) * 1000);
    expect(body.rows[0][0]).toBe(from);
    expect(body.rows[0][4]).toBe(0);
  });

  it('each row with its template provider, grouped as the home page groups them (excluded pools counted: history)', async () => {
    const m = await loadRoute();
    const { body } = await get(m.route);
    expect(m.getTemplateProviderInputs).toHaveBeenCalledWith([]);
    expect(body.row_provider).toHaveLength(body.rows.length);
    const names = body.row_provider.map((i: number) => body.providers[i].name);
    expect(new Set(names)).toEqual(new Set(['Pool 1 +1', 'not on our feeds']));
    expect(body.providers.find((p: { name: string }) => p.name === 'Pool 1 +1')).toMatchObject({ kind: 'producer', pools: ['Pool 1', 'Pool 2'] });
  });

  it('no record yet, or no tip: no rows', async () => {
    expect((await get((await loadRoute({ recordFrom: null })).route)).body).toMatchObject({ record_from: null, rows: [] });
    expect((await get((await loadRoute({ tip: null })).route)).body).toMatchObject({ tip_height: null, rows: [] });
  });

  it('caches the summary per range; a failure is not kept', async () => {
    const m = await loadRoute();
    await get(m.route); await get(m.route);
    expect(m.getChainBlocks).toHaveBeenCalledTimes(1);
    await get(m.route, '?range=all');
    expect(m.getChainBlocks).toHaveBeenCalledTimes(2);
    const f = await loadRoute();
    f.getRecordFrom.mockRejectedValueOnce(new Error('down'));
    expect((await get(f.route)).status).toBe(500);
    expect((await get(f.route)).status).toBe(200);
  });

  it("one block's positions as runs", async () => {
    const m = await loadRoute();
    expect((await get(m.route, '?height=3000001')).body).toEqual({ height: 3_000_001, runs: [[1, 3], [9, 9]] });
    expect(m.getOffPositions).toHaveBeenCalledWith(3_000_001);
  });
});
