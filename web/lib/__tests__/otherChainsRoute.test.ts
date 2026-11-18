/**
 * /api/other-chains against mocked database functions: MongoDB mode and disabled history touch no database,
 * parameter validation, POOL_BLACKLIST passed to both reads, the summary cache (one read per period, served stale
 * while a refresh runs, a failure not kept), and the template mapping.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OtherTemplateRow } from '../db/other-chains';

const row = (pool: string, job: string): OtherTemplateRow => ({
  source_id: 1, source_name: pool, received_us: '1790000000123456', height: 6_976_415, job_id: job,
  prev_hash: Buffer.from('11'.repeat(32), 'hex'), coinbase1: Buffer.from('01', 'hex'), coinbase2: Buffer.from('02', 'hex'),
  merkle_branches: Buffer.alloc(64), version: 536870912, nbits: '386000000', ntime: '1790000000', clean_jobs: true,
  extranonce1: Buffer.from('f00dface', 'hex'), extranonce2_length: 4, chain: 'unknown', reason: 'no_bitcoin_parent', copies: 1,
});

async function loadRoute({ historical = true, backend = 'postgres', blacklist = '' } = {}) {
  vi.resetModules();
  vi.stubEnv('POOL_BLACKLIST', blacklist);
  vi.stubEnv('DB_BACKEND', backend);
  vi.stubEnv('EXTRANONCE1_MASK_KEY', 'route-key');
  const getOtherChainsSummary = vi.fn<(exclude: string[]) => Promise<{ months: string[]; groups: never[] }>>(
    async () => ({ months: ['2026-10'], groups: [] }));
  const getOtherTemplates = vi.fn<(q: unknown, exclude: string[]) => Promise<{ rows: OtherTemplateRow[]; next_before: string | null }>>(async () => ({ rows: [row('P', 'j1')], next_before: '1790000000123456' }));
  vi.doMock('../db/blocks', () => ({ enableHistoricalData: historical }));
  vi.doMock('../db/other-chains', async importOriginal => ({
    ...(await importOriginal<object>()), getOtherChainsSummary, getOtherTemplates,
  }));
  const route = await import('../../app/api/other-chains/route');
  return { route, getOtherChainsSummary, getOtherTemplates };
}

const get = (route: { GET: (r: Request) => Promise<Response> }, qs = '') =>
  route.GET(new Request(`http://localhost/api/other-chains${qs}`));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.doUnmock('../db/blocks');
  vi.doUnmock('../db/other-chains');
});

describe('GET /api/other-chains', () => {
  it('touches no database in MongoDB mode or with history disabled', async () => {
    for (const [opts, enabled] of [[{ backend: 'mongodb' }, true], [{ historical: false }, false]] as const) {
      const { route, getOtherChainsSummary, getOtherTemplates } = await loadRoute(opts);
      for (const qs of ['', '?pool=P']) {
        const body = await (await get(route, qs)).json();
        expect(body).toEqual({ enabled, supported: false });
      }
      expect(getOtherChainsSummary).not.toHaveBeenCalled();
      expect(getOtherTemplates).not.toHaveBeenCalled();
    }
  });

  it('validates parameters', async () => {
    const { route, getOtherTemplates } = await loadRoute();
    for (const qs of ['?pool=', '?pool=P&chain=bch', '?pool=P&reason=DROP%20TABLE', '?pool=P&before=abc',
                      '?pool=P&before=-1', '?pool=P&n=0', '?pool=P&n=1.5', '?pool=P&n=x', `?pool=${'x'.repeat(201)}`]) {
      expect((await get(route, qs)).status, qs).toBe(400);
    }
    expect(getOtherTemplates).not.toHaveBeenCalled();
    expect((await get(route, '?pool=P&chain=btc&reason=stale_bitcoin_parent&n=1000&before=1790000000000000')).status).toBe(200);
    expect(getOtherTemplates).toHaveBeenCalledWith(
      { pool: 'P', chain: 'btc', reason: 'stale_bitcoin_parent', before: '1790000000000000', n: 200 }, []);
  });

  it('passes POOL_BLACKLIST to both reads', async () => {
    const { route, getOtherChainsSummary, getOtherTemplates } = await loadRoute({ blacklist: 'Hidden, Other' });
    await get(route);
    await get(route, '?pool=Hidden');
    expect(getOtherChainsSummary).toHaveBeenCalledWith(['Hidden', 'Other']);
    expect(getOtherTemplates.mock.calls[0][1]).toEqual(['Hidden', 'Other']);
  });

  it('maps template rows: masked extranonce1, display-order prev hash, cursor', async () => {
    const { route } = await loadRoute();
    const res = await get(route, '?pool=P');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=30');
    const text = await res.text();
    expect(text).not.toContain('f00dface');
    const body = JSON.parse(text);
    expect(body.next_before).toBe('1790000000123456');
    expect(body.templates[0]).toMatchObject({
      id: '1-1790000000123456-j1', pool_name: 'P', chain: 'unknown', reason: 'no_bitcoin_parent', height: 6_976_415,
      received_at: 1790000000123, merkle_branches: 2, version: '20000000', coinbase_ok: false, auxpow: false,
    });
    expect(body.templates[0].extranonce1).toHaveLength(8);
  });

  it('computes the summary once per period and serves it stale while refreshing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { route, getOtherChainsSummary } = await loadRoute();
    let release: (v: { months: string[]; groups: never[] }) => void = () => {};
    getOtherChainsSummary
      .mockImplementationOnce(async () => ({ months: ['2026-10'], groups: [] }))
      .mockImplementationOnce(() => new Promise(r => { release = r; }));
    expect((await (await get(route)).json()).months).toEqual(['2026-10']);
    await get(route);
    expect(getOtherChainsSummary).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 6 * 60_000);
    // stale: the old result right away, one refresh in the background
    expect((await (await get(route)).json()).months).toEqual(['2026-10']);
    expect((await (await get(route)).json()).months).toEqual(['2026-10']);
    expect(getOtherChainsSummary).toHaveBeenCalledTimes(2);
    release({ months: ['2026-11'], groups: [] });
    await new Promise(r => setTimeout(r, 0));
    expect((await (await get(route)).json()).months).toEqual(['2026-11']);
  });

  it('does not keep a failed summary', async () => {
    const { route, getOtherChainsSummary } = await loadRoute();
    getOtherChainsSummary.mockRejectedValueOnce(new Error('boom'));
    expect((await get(route)).status).toBe(500);
    expect((await get(route)).status).toBe(200);
    expect(getOtherChainsSummary).toHaveBeenCalledTimes(2);
  });
});

describe('summary mapping', () => {
  it('aligns monthly counts on a gapless month range', async () => {
    const { summaryRowsToSummary, monthRange } = await vi.importActual<typeof import('../db/other-chains')>('../db/other-chains');
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    const s = summaryRowsToSummary([
      { pool: 'A', chain: 'unknown', reason: 'r', n: '4', min_h: 1, max_h: 2, heights: '2', prev_hashes: '1',
        first_ms: '10', last_ms: '20', auxpow: '1', monthly: { '2025-11': 3, '2026-01': '1' } },
      { pool: 'B', chain: 'bch', reason: 'bch', n: '1', min_h: 5, max_h: 5, heights: '1', prev_hashes: '1',
        first_ms: '30', last_ms: '30', auxpow: '0', monthly: { '2025-12': 1 } },
    ]);
    expect(s.months).toEqual(['2025-11', '2025-12', '2026-01']);
    expect(s.groups[0]).toMatchObject({ templates: 4, auxpow_share: 0.25, monthly: [3, 0, 1], first_seen: 10 });
    expect(s.groups[1].monthly).toEqual([0, 1, 0]);
  });
});
