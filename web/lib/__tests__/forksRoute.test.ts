/**
 * /api/forks (and its alias /api/unknown-parents) against mocked database functions: disabled history touches no database, parameter
 * validation (parent, range, the legacy 90d / 1y values), POOL_BLACKLIST passed to every read, the range passed to
 * the summary read with its heights (blocks, tip_height, from_height), the summary cache per range (one read per
 * period, served stale while a refresh runs, a failure not kept), the drill-in looked up in its range's summary and
 * cached, the table-or-live choice (the live read only for the default range while the backend's table is empty), the
 * range's cutoff as a block count, the episode assembly (draftEpisodes / finishEpisodes), stale parents' episodes
 * (kind 'stale' from the recorded fact; their read: one bounded branch per stale block), and the invalid-coinbase
 * findings (a badge on the episodes at that height, else a row of its own; excluded pools left out).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrillRows, EpisodeFactsSql, EpisodePoolSql, InvalidCoinbaseFlagSql } from '../db/unknown-parents';

const P1 = '00'.repeat(10) + '12'.repeat(22);   // meets the target of BITS
const BITS = 0x17034219;
const TIP = 900_010;
const poolRow = (o: Partial<EpisodePoolSql> = {}): EpisodePoolSql => ({
  parent: P1, pool: 'P', n: '3', first_ms: '1000', last_ms: '5000', auxpow: '0', conns: [1],
  heights: { 900001: 3 }, nbits: { [BITS]: 3 }, ...o,
});
const facts = (o: Partial<EpisodeFactsSql> = {}): EpisodeFactsSql =>
  ({ i: 1, tip: 900_000, tip_last: 900_001, bits_prev: String(BITS), bits_at: String(BITS), in_stale: false,
     stale_height: null, stale_header_source: null, stale_miner: null, ...o });
const P2 = '00'.repeat(10) + '34'.repeat(22);   // a stale parent (meets the target too)
const BEST = 'cd'.repeat(32);
const flag = (o: Partial<InvalidCoinbaseFlagSql> = {}): InvalidCoinbaseFlagSql => ({
  height: 900_001, parent: BEST, parent_arrival_ms: '800', arrival_ms: '9000', tip: TIP,
  offenders: [
    { pool_name: 'P', total_sats: 328_000_000, subsidy_sats: 312_500_000 },
    { pool_name: 'P', total_sats: 329_000_000, subsidy_sats: 312_500_000 },
    { pool_name: 'Q', total_sats: 320_000_000, subsidy_sats: 312_500_000 },
    { pool_name: 'Hidden', total_sats: 330_000_000, subsidy_sats: 312_500_000 },
  ], ...o,
});
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
  const getEpisodePoolRows = vi.fn<(exclude: string[], range?: string) => Promise<EpisodePoolSql[]>>(async () => [poolRow()]);
  const getEpisodeFacts = vi.fn<(q: unknown[]) => Promise<EpisodeFactsSql[]>>(async () => [facts()]);
  const getDrillRows = vi.fn<(q: unknown, exclude: string[]) => Promise<DrillRows>>(async () => drillRows());
  const getBestTipHeight = vi.fn<() => Promise<number | null>>(async () => TIP);
  const getStaleEpisodePoolRows = vi.fn<(exclude: string[], range?: string) => Promise<EpisodePoolSql[]>>(async () => []);
  const getInvalidCoinbaseFlags = vi.fn<() => Promise<InvalidCoinbaseFlagSql[]>>(async () => []);
  vi.doMock('../db/blocks', () => ({ enableHistoricalData: historical }));
  vi.doMock('../db/unknown-parents', async importOriginal => ({
    ...(await importOriginal<object>()), getEpisodePoolRows, getEpisodeFacts, getDrillRows, getBestTipHeight,
    getStaleEpisodePoolRows, getInvalidCoinbaseFlags,
  }));
  const route = await import('../../app/api/forks/route');
  return { route, getEpisodePoolRows, getEpisodeFacts, getDrillRows, getBestTipHeight, getStaleEpisodePoolRows, getInvalidCoinbaseFlags };
}

const get = (route: { GET: (r: Request) => Promise<Response> }, qs = '') =>
  route.GET(new Request(`http://localhost/api/forks${qs}`));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.doUnmock('../db/blocks');
  vi.doUnmock('../db/unknown-parents');
});

describe('GET /api/forks', () => {
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
    expect(body).toMatchObject({ enabled: true, supported: true, range: '6e', blocks: 12_096, tip_height: TIP,
      from_height: TIP - 12_096 });
    expect(body.before_first_block).toBe(0);
    expect(body).not.toHaveProperty('days');
    expect(body).not.toHaveProperty('window_start');
    expect(Math.abs(Date.now() - body.generated_at)).toBeLessThan(60_000);
    expect(getEpisodeFacts).toHaveBeenCalledWith([{ parent: P1, height: 900_001, first_ms: 1000, last_ms: 5000 }]);
    expect(body.episodes).toEqual([{
      parent: P1, height: 900_001, heights: [900_001], pools: [{ pool: 'P', connections: ['a'], templates: 3 }],
      first_ms: 1000, last_ms: 5000, duration_ms: 4000, templates: 3, auxpow_templates: 0, auxpow_share: 0,
      facts: { tip_at_first: 900_000, tip_at_last: 900_001, tip_offset: 0, nbits: ['17034219'], bitcoin_bits: '17034219',
        bitcoin_bits_at: '17034219', bitcoin_difficulty: true, pow_ok: true, pow_bits: '17034219', in_stale_blocks: false,
        stale_block: null },
      kind: 'bitcoin_block', invalid_coinbase: null,
    }]);
  });

  it('serves the alias /api/unknown-parents from the same handler and caches', async () => {
    const { route, getEpisodePoolRows } = await loadRoute();
    const alias = await import('../../app/api/unknown-parents/route');
    expect(alias.GET).toBe(route.GET);
    expect(alias.dynamic).toBe('force-dynamic');
    await get(route);
    expect((await (await alias.GET(new Request('http://localhost/api/unknown-parents'))).json()).episodes).toHaveLength(1);
    expect(getEpisodePoolRows).toHaveBeenCalledTimes(1);
  });

  it('serves a recorded stale parent as kind stale, with its block, next to the unknown ones', async () => {
    const { route, getEpisodeFacts, getStaleEpisodePoolRows } = await loadRoute({ blacklist: 'Hidden' });
    getStaleEpisodePoolRows.mockResolvedValueOnce([
      poolRow({ parent: P2, pool: 'S', first_ms: '500', last_ms: '700', n: '2', auxpow: null, heights: { 900001: 2 } }),
    ]);
    getEpisodeFacts.mockImplementationOnce(async q => q.map((_, i) => i === 0
      ? facts({ i: 1, in_stale: true, stale_height: 900_000, stale_header_source: 'node', stale_miner: 'M' }) : facts({ i: 2 })));
    const body = await (await get(route)).json();
    expect(getStaleEpisodePoolRows).toHaveBeenCalledWith(['Hidden'], '6e');
    expect(body.episodes.map((e: { parent: string; kind: string }) => [e.parent, e.kind])).toEqual([[P2, 'stale'], [P1, 'bitcoin_block']]);
    expect(body.episodes[0]).toMatchObject({ auxpow_templates: null, auxpow_share: null, templates: 2,
      facts: { in_stale_blocks: true, stale_block: { height: 900_000, header_source: 'node', miner: 'M' }, pow_ok: true } });
  });

  it('does not name a stale block\'s miner that is an excluded pool', async () => {
    const { route, getEpisodeFacts, getStaleEpisodePoolRows } = await loadRoute({ blacklist: 'Hidden' });
    getStaleEpisodePoolRows.mockResolvedValueOnce([poolRow({ parent: P2, pool: 'S', first_ms: '500', last_ms: '700', auxpow: null })]);
    getEpisodeFacts.mockImplementationOnce(async q => q.map((_, i) => i === 0
      ? facts({ i: 1, in_stale: true, stale_height: 900_000, stale_header_source: 'node', stale_miner: 'HIDDEN' }) : facts({ i: 2 })));
    const res = await get(route);
    const text = await res.clone().text();
    expect(text.toLowerCase()).not.toContain('hidden');
    expect((await res.json()).episodes[0].facts.stale_block).toEqual({ height: 900_000, header_source: 'node', miner: null });
  });

  it('badges the episodes at a finding\'s height (per pool, excluded pools left out)', async () => {
    const { route, getInvalidCoinbaseFlags } = await loadRoute({ blacklist: 'Hidden' });
    getInvalidCoinbaseFlags.mockResolvedValueOnce([flag()]);
    const body = await (await get(route)).json();
    expect(body.episodes).toHaveLength(1);
    expect(body.episodes[0].invalid_coinbase).toEqual({ height: 900_001, pools: [
      { pool: 'P', templates: 2, total_sats: 329_000_000, subsidy_sats: 312_500_000 },
      { pool: 'Q', templates: 1, total_sats: 320_000_000, subsidy_sats: 312_500_000 },
    ] });
  });

  it('makes a finding with no episode at its height a row of its own; drops one left without offenders', async () => {
    const { route, getInvalidCoinbaseFlags, getDrillRows } = await loadRoute({ blacklist: 'Hidden' });
    getInvalidCoinbaseFlags.mockResolvedValue([
      flag({ height: 900_005 }),
      flag({ height: 900_006, parent: 'ef'.repeat(32), offenders: [{ pool_name: 'Hidden', total_sats: 1, subsidy_sats: 0 }] }),
      flag({ height: TIP - 12_096, parent: 'ee'.repeat(32) }),     // below the range
    ]);
    const body = await (await get(route)).json();
    expect(body.episodes).toHaveLength(2);
    const row = body.episodes.find((e: { kind: string }) => e.kind === 'invalid_coinbase');
    expect(row).toMatchObject({ parent: BEST, height: 900_005, first_ms: 800, last_ms: 9000, duration_ms: 8200, templates: 3,
      pools: [{ pool: 'P', connections: [], templates: 2 }, { pool: 'Q', connections: [], templates: 1 }],
      facts: { tip_at_first: 900_004, tip_offset: 0 }, invalid_coinbase: { height: 900_005 } });
    expect(body.episodes.find((e: { kind: string }) => e.kind !== 'invalid_coinbase').invalid_coinbase).toBeNull();
    // its drill-in labels our best block as the best chain, not "this parent"
    expect((await get(route, `?parent=${BEST}`)).status).toBe(200);
    expect(getDrillRows.mock.calls[0][0]).toMatchObject({ parent: '', height: 900_005, pools: ['P', 'Q'] });
    expect((await (await get(route, '?range=all')).json()).episodes).toHaveLength(3);   // all history: the old one too
  });

  it('does not badge another chain\'s episode passing through the height, or one away from our tip', async () => {
    const { route, getEpisodeFacts, getInvalidCoinbaseFlags } = await loadRoute();
    getInvalidCoinbaseFlags.mockResolvedValue([flag()]);
    getEpisodeFacts.mockResolvedValueOnce([facts({ bits_prev: '1', bits_at: '1' })]);          // other chain
    const other = (await (await get(route)).json()).episodes;
    expect(other.map((e: { kind: string; invalid_coinbase: unknown }) => [e.kind, e.invalid_coinbase === null]))
      .toEqual([['invalid_coinbase', false], ['other_chain', true]]);   // oldest first
    getEpisodeFacts.mockResolvedValueOnce([facts({ tip: 899_000 })]);                          // far below our tip
    const far = (await (await get(route, '?range=26e')).json()).episodes;
    expect(far.map((e: { kind: string }) => e.kind)).toEqual(['invalid_coinbase', 'bitcoin_block']);
  });

  it('leaves out an episode that began before our first stored block, and counts it', async () => {
    const { route, getEpisodeFacts } = await loadRoute();
    getEpisodeFacts.mockResolvedValueOnce([facts({ tip: null, tip_last: null, bits_prev: null, bits_at: null })]);
    const body = await (await get(route)).json();
    expect(body.episodes).toEqual([]);
    expect(body.before_first_block).toBe(1);
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

  it('passes POOL_BLACKLIST to the summary reads', async () => {
    const { route, getEpisodePoolRows, getStaleEpisodePoolRows } = await loadRoute({ blacklist: 'Hidden, Other' });
    await get(route);
    expect(getEpisodePoolRows).toHaveBeenCalledWith(['Hidden', 'Other'], '6e');
    expect(getStaleEpisodePoolRows).toHaveBeenCalledWith(['Hidden', 'Other'], '6e');
  });

  it('reads the range asked for, with its heights, cached per range; rejects others', async () => {
    const { route, getEpisodePoolRows } = await loadRoute();
    const y = await (await get(route, '?range=26e')).json();
    expect(y).toMatchObject({ range: '26e', blocks: 52_416, tip_height: TIP, from_height: TIP - 52_416 });
    const all = await (await get(route, '?range=all')).json();
    // all history starts at the lowest tip an episode was first seen at
    expect(all).toMatchObject({ range: 'all', blocks: null, tip_height: TIP, from_height: 900_000 });
    expect(getEpisodePoolRows.mock.calls.map(c => c[1])).toEqual(['26e', 'all']);
    await get(route, '?range=26e');
    await get(route);
    expect(getEpisodePoolRows.mock.calls.map(c => c[1])).toEqual(['26e', 'all', '6e']);
    for (const qs of ['?range=30d', '?range=', '?range=toString', '?range=6E', `?range=ALL&parent=${P1}`]) {
      expect((await get(route, qs)).status, qs).toBe(400);
    }
    getEpisodePoolRows.mockImplementation(async () => []);
    const none = await (await get(route, '?range=all&x=1')).json();          // cached: still the first result
    expect(none.episodes).toHaveLength(1);
  });

  it('reads the earlier wall-clock values as epochs (shared links), and names the new ones', async () => {
    const { route, getEpisodePoolRows, getDrillRows } = await loadRoute();
    expect(await (await get(route, '?range=1y')).json()).toMatchObject({ range: '26e', blocks: 52_416 });
    expect(await (await get(route, '?range=90d')).json()).toMatchObject({ range: '6e', blocks: 12_096 });
    await get(route, '?range=26e');
    await get(route);
    expect(getEpisodePoolRows.mock.calls.map(c => c[1])).toEqual(['26e', '6e']);   // one cache entry each
    expect((await get(route, `?parent=${P1}&range=90d`)).status).toBe(200);
    expect((await get(route, `?parent=${P1}`)).status).toBe(200);
    expect(getDrillRows).toHaveBeenCalledTimes(1);                                  // one drill-in cache entry too
  });

  it('starts all history at the tip without episodes; no heights without blocks', async () => {
    const { route, getEpisodePoolRows, getBestTipHeight } = await loadRoute();
    getEpisodePoolRows.mockImplementation(async () => []);
    expect(await (await get(route, '?range=all')).json()).toMatchObject({ episodes: [], tip_height: TIP, from_height: TIP });
    getBestTipHeight.mockImplementation(async () => null);
    expect(await (await get(route, '?range=26e')).json()).toMatchObject({ tip_height: null, from_height: null, blocks: 52_416 });
  });

  it('looks a drill-in up in its range', async () => {
    const { route, getEpisodePoolRows, getDrillRows } = await loadRoute();
    getEpisodePoolRows.mockImplementation(async (_x, range) => (range === 'all' ? [poolRow()] : []));
    expect((await get(route, `?parent=${P1}`)).status).toBe(404);
    expect((await get(route, `?parent=${P1}&range=all`)).status).toBe(200);
    expect(getDrillRows).toHaveBeenCalledTimes(1);
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
    vi.setSystemTime(Date.now() + 6 * 60_000);    // past SUMMARY_MS (5 min)
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
    const [ff, e] = finishEpisodes(drafts, [facts({ tip: null, tip_last: null, bits_prev: null, bits_at: null }), facts()]);
    expect(e.facts.nbits).toEqual(['17034219', '00000001']);
    expect(e.kind).toBe('bitcoin_block');
    expect(ff.kind).toBe('undetermined');
    expect(e.facts).toMatchObject({ tip_at_first: 900_000, tip_at_last: 900_001 });
    expect(ff.facts).toMatchObject({ tip_at_first: null, tip_at_last: null, tip_offset: null, bitcoin_bits: null, pow_ok: false, pow_bits: '17034219' });
  });
});

describe('summary source', () => {
  afterEach(() => { vi.doUnmock('../db/pg'); });

  // getEpisodePoolRows with a mocked pool: the first query is the emptiness check
  async function load(filled: boolean) {
    vi.resetModules();
    const sql: string[] = [];
    const query = vi.fn(async (text: string, params?: unknown[]) => {
      sql.push(text);
      if (text.includes('EXISTS (SELECT 1 FROM unknown_parent_pools)')) return { rows: [{ filled }] };
      return { rows: [], params };
    });
    vi.doMock('../db/pg', () => ({ getPgPool: () => ({ query }) }));
    const db = await import('../db/unknown-parents');
    return { db, sql, query };
  }

  it('reads the table, with the range as a block count below the tip, judging "unknown" at read time', async () => {
    const { db, sql, query } = await load(true);
    await db.getEpisodePoolRows(['Hidden'], '6e');
    await db.getEpisodePoolRows(['Hidden'], '26e');
    await db.getEpisodePoolRows(['Hidden'], 'all');
    const reads = query.mock.calls.filter(c => c[0].includes('FROM unknown_parent_pools u'));
    expect(reads).toHaveLength(3);
    expect(reads[0][0]).toContain('NOT EXISTS (SELECT 1 FROM bitcoin_parents p WHERE p.prev_hash = u.prev_hash)');
    expect(reads[0][0]).toContain('(SELECT max(height) FROM blocks_best) - $2::int');
    expect(reads.map(r => r[1])).toEqual([[['Hidden'], 12_096], [['Hidden'], 52_416], [['Hidden'], null]]);
    expect(sql.some(t => t.includes('FROM templates'))).toBe(false);
  });

  it('reads stale parents in one bounded read: a branch per stale block with its height, window and hash as values', async () => {
    vi.resetModules();
    const query = vi.fn(async (text: string) => {
      if (text.includes('FROM stale_blocks s CROSS JOIN LATERAL template_height_windows')) return { rows: [
        { parent: 'aa'.repeat(32), height: 900_001, w_from: '2026-01-01 00:00:00+00', w_to: '2026-01-01 03:00:00+00', cut_ms: '5000' },
        { parent: 'bb'.repeat(32), height: 900_101, w_from: '2026-01-02 00:00:00+00', w_to: 'infinity', cut_ms: '5000' },
      ] };
      return { rows: [
        poolRow({ parent: 'aa'.repeat(32), pool: 'A', last_ms: '4000' }),          // ended before the cutoff
        poolRow({ parent: 'bb'.repeat(32), pool: 'A', last_ms: '4000' }),
        poolRow({ parent: 'bb'.repeat(32), pool: 'B', last_ms: '6000' }),          // ... this pool's didn't: shown whole
      ] };
    });
    vi.doMock('../db/pg', () => ({ getPgPool: () => ({ query }) }));
    const db = await import('../db/unknown-parents');
    const rows = await db.getStaleEpisodePoolRows(['Hidden'], '6e');
    expect(rows.map(r => [r.parent.slice(0, 2), r.pool])).toEqual([['bb', 'A'], ['bb', 'B']]);
    const [first, second] = query.mock.calls as unknown as [string, unknown[]][];
    expect(first[0]).toContain('s.reorged_in_at IS NULL AND w.w_to >= cut.at');
    expect(first[1]).toEqual([12_096]);
    expect(second[0].match(/FROM templates t/g)).toHaveLength(2);
    expect(second[0]).not.toContain('coinbase1');
    expect(second[0]).toContain("t.prev_hash = stratum_prev_hash_to_block_hash(decode($5::text, 'hex'))");
    expect(second[1]).toEqual([['Hidden'], 900_001, '2026-01-01 00:00:00+00', '2026-01-01 03:00:00+00', 'aa'.repeat(32),
      900_101, '2026-01-02 00:00:00+00', 'infinity', 'bb'.repeat(32)]);
    query.mockImplementationOnce(async () => ({ rows: [] }));
    query.mockClear();
    expect(await db.getStaleEpisodePoolRows([], 'all')).toEqual([]);           // no stale block: no templates read
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('falls back to the live read of templates while the table is empty (the default range only)', async () => {
    const { db, sql } = await load(false);
    await db.getEpisodePoolRows([], '6e');
    expect(sql.some(t => t.includes('FROM templates t'))).toBe(true);
    expect(sql.some(t => t.includes('FROM unknown_parent_pools u'))).toBe(false);
    sql.length = 0;
    await db.getEpisodePoolRows([], '26e');
    expect(sql.some(t => t.includes('FROM templates'))).toBe(false);
    expect(sql.some(t => t.includes('FROM unknown_parent_pools u'))).toBe(true);
  });
});
