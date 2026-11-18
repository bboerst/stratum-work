/**
 * /api/unknown-parents against mocked database functions: disabled history touches no database, parameter
 * validation, POOL_BLACKLIST passed to every read, the summary cache (one read per period, served stale while a
 * refresh runs, a failure not kept), the drill-in looked up in the summary and cached, and the episode assembly
 * (draftEpisodes / finishEpisodes).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrillRows, EpisodeFactsSql, EpisodePoolSql } from '../db/unknown-parents';

const P1 = '00'.repeat(10) + '12'.repeat(22);   // meets the target of BITS
const BITS = 0x17034219;
const poolRow = (o: Partial<EpisodePoolSql> = {}): EpisodePoolSql => ({
  parent: P1, pool: 'P', n: '3', first_ms: '1000', last_ms: '5000', auxpow: '0', conns: [1],
  heights: { 900001: 3 }, nbits: { [BITS]: 3 }, ...o,
});
const facts = (o: Partial<EpisodeFactsSql> = {}): EpisodeFactsSql =>
  ({ i: 1, tip: 900_000, bits_prev: String(BITS), bits_at: String(BITS), in_stale: false, ...o });
const drillRows = (): DrillRows => ({
  truncated: false,
  blocks: [{ block_hash: 'ab'.repeat(32), height: 900_000, arrival_ms: '900', best: true }],
  templates: [{
    source_id: 1, source_name: 'P', received_us: '1000123', height: 900_001, job_id: 'j1',
    prev_hash: Buffer.from('11'.repeat(32), 'hex'), coinbase1: Buffer.from('01', 'hex'), coinbase2: Buffer.from('02', 'hex'),
    merkle_branches: Buffer.alloc(64), version: 536870912, nbits: String(BITS), ntime: '1790000000', clean_jobs: true,
    extranonce1: Buffer.from('f00dface', 'hex'), extranonce2_length: 4, copies: 2, conns: [2, 1], parent_label: 'this',
  }],
});

async function loadRoute({ historical = true, blacklist = '' } = {}) {
  vi.resetModules();
  vi.stubEnv('POOL_BLACKLIST', blacklist);
  vi.stubEnv('EXTRANONCE1_MASK_KEY', 'route-key');
  const getEpisodePoolRows = vi.fn<(exclude: string[]) => Promise<EpisodePoolSql[]>>(async () => [poolRow()]);
  const getEpisodeFacts = vi.fn<(q: unknown[]) => Promise<EpisodeFactsSql[]>>(async () => [facts()]);
  const getDrillRows = vi.fn<(q: unknown, exclude: string[]) => Promise<DrillRows>>(async () => drillRows());
  vi.doMock('../db/blocks', () => ({ enableHistoricalData: historical }));
  vi.doMock('../db/unknown-parents', async importOriginal => ({
    ...(await importOriginal<object>()), getEpisodePoolRows, getEpisodeFacts, getDrillRows,
  }));
  const route = await import('../../app/api/unknown-parents/route');
  return { route, getEpisodePoolRows, getEpisodeFacts, getDrillRows };
}

const get = (route: { GET: (r: Request) => Promise<Response> }, qs = '') =>
  route.GET(new Request(`http://localhost/api/unknown-parents${qs}`));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.doUnmock('../db/blocks');
  vi.doUnmock('../db/unknown-parents');
});

describe('GET /api/unknown-parents', () => {
  it('touches no database with history disabled', async () => {
    const { route, getEpisodePoolRows, getDrillRows } = await loadRoute({ historical: false });
    for (const qs of ['', `?parent=${P1}`]) expect(await (await get(route, qs)).json()).toEqual({ enabled: false, supported: false });
    expect(getEpisodePoolRows).not.toHaveBeenCalled();
    expect(getDrillRows).not.toHaveBeenCalled();
  });

  it('serves episodes with facts and the inferred kind', async () => {
    const { route, getEpisodeFacts } = await loadRoute();
    const res = await get(route);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    const body = await res.json();
    expect(body).toMatchObject({ enabled: true, supported: true, days: 90 });
    expect(body.generated_at - body.window_start).toBe(90 * 86_400_000);
    expect(getEpisodeFacts).toHaveBeenCalledWith([{ parent: P1, height: 900_001, first_ms: 1000 }]);
    expect(body.episodes).toEqual([{
      parent: P1, height: 900_001, heights: [900_001], pools: [{ pool: 'P', connections: ['a'], templates: 3 }],
      first_ms: 1000, last_ms: 5000, duration_ms: 4000, templates: 3, auxpow_templates: 0, auxpow_share: 0,
      facts: { tip_at_first: 900_000, tip_offset: 0, nbits: ['17034219'], bitcoin_bits: '17034219',
        bitcoin_bits_at: '17034219', bitcoin_difficulty: true, pow_ok: true, pow_bits: '17034219', in_stale_blocks: false },
      kind: 'bitcoin_block',
    }]);
  });

  it('validates the parent and 404s one that is no episode', async () => {
    const { route, getDrillRows } = await loadRoute();
    for (const qs of ['?parent=', '?parent=xyz', `?parent=${'0'.repeat(63)}`, `?parent=${'g'.repeat(64)}`]) {
      expect((await get(route, qs)).status, qs).toBe(400);
    }
    expect((await get(route, `?parent=${'34'.repeat(32)}`)).status).toBe(404);
    expect(getDrillRows).not.toHaveBeenCalled();
  });

  it('drills into an episode from the summary: bounded read, labels, masked rows, cached', async () => {
    const { route, getDrillRows } = await loadRoute({ blacklist: 'Hidden' });
    const res = await get(route, `?parent=${P1.toUpperCase()}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('f00dface');
    const body = JSON.parse(text);
    expect(getDrillRows).toHaveBeenCalledWith(
      { parent: P1, height: 900_001, pools: ['P'], from_ms: 1000 - 300_000, to_ms: 5000 + 300_000 }, ['Hidden']);
    expect(body).toMatchObject({ from_ms: 1000 - 300_000, to_ms: 305_000, truncated: false, episode: { parent: P1 },
      blocks: [{ hash: 'ab'.repeat(32), height: 900_000, arrival_ms: 900, best: true }] });
    expect(body.templates[0]).toMatchObject({ id: '1-1000123-j1', pool_name: 'P', parent: 'this', connections: ['a', 'b'],
      copies: 2, received_at: 1000, height: 900_001, merkle_branches: 2 });
    await get(route, `?parent=${P1}`);
    expect(getDrillRows).toHaveBeenCalledTimes(1);
  });

  it('passes POOL_BLACKLIST to the summary read', async () => {
    const { route, getEpisodePoolRows } = await loadRoute({ blacklist: 'Hidden, Other' });
    await get(route);
    expect(getEpisodePoolRows).toHaveBeenCalledWith(['Hidden', 'Other']);
  });

  it('computes the summary once per period and serves it stale while refreshing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { route, getEpisodePoolRows } = await loadRoute();
    let release: (v: EpisodePoolSql[]) => void = () => {};
    getEpisodePoolRows
      .mockImplementationOnce(async () => [poolRow()])
      .mockImplementationOnce(() => new Promise(r => { release = r; }));
    expect((await (await get(route)).json()).episodes).toHaveLength(1);
    await get(route);
    expect(getEpisodePoolRows).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 31 * 60_000);   // past SUMMARY_MS (30 min)
    expect((await (await get(route)).json()).episodes).toHaveLength(1);
    expect((await (await get(route)).json()).episodes).toHaveLength(1);
    expect(getEpisodePoolRows).toHaveBeenCalledTimes(2);
    release([]);
    await new Promise(r => setTimeout(r, 0));
    expect((await (await get(route)).json()).episodes).toEqual([]);
  });

  it('does not keep a failed summary', async () => {
    const { route, getEpisodePoolRows } = await loadRoute();
    getEpisodePoolRows.mockRejectedValueOnce(new Error('boom'));
    expect((await get(route)).status).toBe(500);
    expect((await get(route)).status).toBe(200);
    expect(getEpisodePoolRows).toHaveBeenCalledTimes(2);
  });
});

describe('episode assembly', () => {
  it('merges pools of one parent, orders them, picks the most common height and nbits deterministically', async () => {
    const { draftEpisodes, finishEpisodes, modeOf } =
      await vi.importActual<typeof import('../unknownParents')>('../unknownParents');
    expect(modeOf(new Map([[5, 2], [3, 2], [9, 1]]))).toBe(3);
    const drafts = draftEpisodes([
      poolRow({ pool: 'B', first_ms: '2000', last_ms: '9000', conns: [2, 1], heights: { 900001: 1, 900002: 2 },
        nbits: { 1: 2, [BITS]: 1 }, auxpow: '1' }),
      poolRow({ pool: 'A', heights: { 900002: 1, 900001: 2 }, nbits: { [BITS]: 3 } }),
      poolRow({ parent: 'ff'.repeat(32), pool: 'A', first_ms: '500', last_ms: '500', n: '1' }),
    ]);
    expect(drafts.map(d => d.parent)).toEqual(['ff'.repeat(32), P1]);
    const d = drafts[1];
    expect(d).toMatchObject({ height: 900_001, heights: [900_001, 900_002], first_ms: 1000, last_ms: 9000,
      duration_ms: 8000, templates: 6, auxpow_templates: 1, auxpow_share: 1 / 6 });
    expect(d.pools).toEqual([{ pool: 'A', connections: ['a'], templates: 3 }, { pool: 'B', connections: ['a', 'b'], templates: 3 }]);
    const [ff, e] = finishEpisodes(drafts, [facts({ tip: null, bits_prev: null, bits_at: null }), facts()]);
    expect(e.facts.nbits).toEqual(['17034219', '00000001']);
    expect(e.kind).toBe('bitcoin_block');
    expect(ff.kind).toBe('undetermined');
    expect(ff.facts).toMatchObject({ tip_at_first: null, tip_offset: null, bitcoin_bits: null, pow_ok: false, pow_bits: '17034219' });
  });
});
