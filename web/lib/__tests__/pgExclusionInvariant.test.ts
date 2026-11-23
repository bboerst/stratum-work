/**
 * The exclusion invariant (POOL_BLACKLIST): an excluded pool is invisible in every API response, as a feed and as a
 * payee or miner, as if it had never been collected. Every route under app/api is found on disk, so a new route fails
 * this suite until it has a case here. Each case is called twice against one seeded, migrated database (as a user in
 * the stratum_web role):
 *   - with no blacklist: the excluded name must appear, so the seed reaches that route (a known-case gate);
 *   - with POOL_BLACKLIST set: the name (case-insensitive) must appear nowhere except at the JSON paths of that case's
 *     allowlist, every allowlist entry must still be hit (a stale entry fails), and the control pool must appear.
 * The allowlist holds documented behaviour that keeps the name, each entry with the reason the code gives for it.
 *
 * Seed (synthetic names only): feeds ExcludedPoolX (excluded) and ControlPoolY, both with templates, on a short chain
 * B(H-2) mined by the excluded pool, B(H-1) by the control pool, B(H) by the control pool (the tip, seconds old),
 * plus a stale block S at H-1 mined by the excluded pool. Templates at H on B(H-1), on S (a stale parent), on U (an
 * unknown parent, both feeds) and on UX (an unknown parent only the excluded feed built on); at H+1 (above the tip)
 * on B(H). The control feed's templates at H also name the excluded pool in their coinbase (a payee), and the
 * transaction-set counts behind template providers have the control feed paying the excluded pool. An invalid-coinbase
 * finding on B(H) lists both pools as offenders. The forks summaries are filled by the functions the backend calls.
 *
 * Holds TIP_LOCK (like pgForks, pgBlocksBest and pgTemplateProviders), since its tip must be the highest block while
 * it runs. Skipped unless a test database is configured:
 *
 *   PG_TEST_HOST=… PG_TEST_USER=web PG_TEST_PASSWORD=… PG_TEST_ADMIN_DSN=postgresql://… npm test
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Client } from 'pg';

const env = process.env;
const enabled = !!env.PG_TEST_HOST;
const TIP_LOCK = 72_010_261;                // the same key in pgForks, pgBlocksBest and pgTemplateProviders

const EXCLUDED = 'ExcludedPoolX';
const CONTROL = 'ControlPoolY';
const EXCLUDED_RE = new RegExp(EXCLUDED, 'i');
const CONTROL_RE = new RegExp(CONTROL, 'i');

const API_DIR = fileURLToPath(new URL('../../app/api', import.meta.url));

/** Every route under app/api, as its directory relative to app/api ('forks', 'tx/[txid]'). */
function discoverRoutes(dir = API_DIR): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...discoverRoutes(p));
    else if (name === 'route.ts') out.push(relative(API_DIR, dir).split(sep).join('/'));
  }
  return out.sort();
}

/** The JSON paths (indices as [*]) whose string value, or key, names the excluded pool. */
function namePaths(v: unknown, path = '$'): string[] {
  if (typeof v === 'string') return EXCLUDED_RE.test(v) ? [path] : [];
  if (Array.isArray(v)) return v.flatMap(x => namePaths(x, `${path}[*]`));
  if (v && typeof v === 'object') {
    return Object.entries(v).flatMap(([k, x]) => [...(EXCLUDED_RE.test(k) ? [`${path}.${k} (key)`] : []), ...namePaths(x, `${path}.${k}`)]);
  }
  return [];
}

interface Allowed { path: string; why: string }
interface Case {
  qs?: string;
  params?: Record<string, string>;
  /** The route serves no pool data at all (no seeded name can reach it): only "never names it" is checked. */
  noPoolData?: string;
  allow?: Allowed[];
}

// Documented behaviour that names the excluded pool. Keep each entry to the narrowest path, with the code's reason.
// None of these is about template providers: those must stay empty.
const BLOCK_MINER: Allowed = {
  path: '$.blocks[*].mining_pool.name',
  why: 'a block names the pool that mined it (blocks strip; lib/db/postgres.ts R5 has no POOL_BLACKLIST filter)',
};
const STALE_SIBLING: Allowed = {
  path: '$.blocks[*].stale_siblings[*].pool',
  why: 'a stale block at the same height is named by its miner, like the block itself (withStaleSiblings)',
};
const BLOCK_FINDING: Allowed = {
  path: '$.blocks[*].analysis.flags[*].details.offenders[*].pool_name',
  why: 'a block\'s stored analysis findings are served as stored (blocks strip, invalid-coinbase badge)',
};
const STALE_MINER: Allowed = {
  path: '$.episodes[*].facts.stale_block.miner',
  why: 'a stale block names the pool that mined it, like any block: history, not realtime work (finishEpisodes)',
};
const DRILL_MINER = 'every block at h - 1 and h names its miner, stale or not (getDrillBlocks), like the blocks strip';
const COINBASE_TEXT = 'a template\'s coinbase text, decoded as the pool sent it: the control feed\'s coinbase names the '
  + 'pool it pays (another feed\'s raw bytes; filtering them would mean dropping that feed\'s templates)';
const HISTORY: Allowed = {
  path: '$.results[*].mining_notifications[*].pool_name',
  why: 'analysis-data keeps excluded feeds\' templates at mined heights (history for analysis, #162); only templates '
    + 'above the tip are filtered (filterBlacklistedAboveTip)',
};

let H = 0;          // set in beforeAll
let S = '', U = '', UX = '', TXID = '';

function cases(): Record<string, Case[]> {
  return {
    'analysis-data': [
      { qs: `height=${H}`, allow: [
        HISTORY,
        { path: '$.results[*].blocks[*].miner', why: DRILL_MINER },
        { path: '$.results[*].mining_notifications[*].coinbaseScriptASCII', why: COINBASE_TEXT },
      ] },
      { qs: `height=${H + 1}` },
      { qs: `height=${H - 1}`, allow: [
        HISTORY,
        { path: '$.results[*].previous_block.mining_pool.name', why: BLOCK_MINER.why },
        // the fork chart's arrival markers: getDrillBlocks names every block's miner, as the blocks strip does
        { path: '$.results[*].blocks[*].miner', why: BLOCK_MINER.why },
      ] },
      { qs: 'interesting=true', allow: [
        { path: '$.items[*].analysis.flags[*].details.offenders[*].pool_name', why: BLOCK_FINDING.why },
      ] },
    ],
    'block-pool-first-seen': [{ qs: `height=${H}` }],
    'blocks': [
      { qs: 'n=20', allow: [BLOCK_MINER, STALE_SIBLING, BLOCK_FINDING] },
      { qs: `height=${H - 1}&n=6`, allow: [BLOCK_MINER, STALE_SIBLING, BLOCK_FINDING] },
    ],
    'forks': [
      { qs: 'range=all', allow: [STALE_MINER] },
      // a drill-in shows every template in the episode's minutes, each labelled by its parent: the control feed's work
      // on B(H-1) too
      { qs: `range=all&parent=${U}`, allow: [{ path: '$.templates[*].coinbase_tags', why: COINBASE_TEXT },
        { path: '$.blocks[*].miner', why: DRILL_MINER }] },
      { qs: `range=all&parent=${S}`, allow: [{ path: '$.templates[*].coinbase_tags', why: COINBASE_TEXT },
        { path: '$.blocks[*].miner', why: DRILL_MINER }, { path: '$.episode.facts.stale_block.miner', why: STALE_MINER.why }] },
    ],
    // the Forks rows' timeline: excluded pools are left out of it, as from the rest of /api/forks
    'forks/timeline': [{ qs: `height=${H}`, allow: [{ path: '$.blocks[*].miner', why: DRILL_MINER }] }],
    'mining-notify': [{ qs: `height=${H}` }, { qs: `height=${H + 1}` }],
    'pools': [{}],
    'realtime-prefill': [{}],
    'runtime-config': [{ noPoolData: 'configuration only (stream endpoint, flags)' }],
    'stale-blocks': [{ qs: 'n=20', allow: [
      { path: '$.stale_blocks[*].mining_pool.name', why: 'a stale block names the pool that mined it, like a block' },
      { path: '$.stale_blocks[*].templates[*].pool',
        why: 'templates on a stale block below the tip are history and stay (stale-blocks route; filterBlacklistedAboveTip)' },
    ] }],
    'stream': [{ allow: [
      { path: '$[*].data.mining_pool.name', why: 'a block event names the pool that mined it, like /api/blocks' },
    ] }],
    'template-providers': [{ qs: 'range=all' }],
    'tx': [{ qs: `txids=${TXID}`, noPoolData: 'mempool transactions: no pool fields' }],
    'tx/[txid]': [{ params: { txid: TXID }, noPoolData: 'mempool transactions: no pool fields' }],
    'unknown-parents': [{ qs: 'range=all', allow: [STALE_MINER] }],
  };
}

/** Live stream messages the mocked RabbitMQ delivers: both feeds' templates, a block event by each pool, then an end marker. */
function streamMessages(): unknown[] {
  const t = (pool: string, job: string) => ({
    id: `${pool}-${job}`, height: H + 1, pool_name: pool, job_id: job, coinbase1: '01', coinbase2: '02', merkle_branches: [],
    version: '20000000', prev_hash: '00'.repeat(32), timestamp: (BigInt(Date.now()) * BigInt(1_000_000)).toString(16),
    nbits: '207fffff', ntime: '66000000', clean_jobs: true, extranonce1: 'aabbccdd', extranonce2_length: 4,
  });
  const block = (pool: string, height: number) => ({ type: 'block', id: `b-${height}`, timestamp: new Date().toISOString(),
    data: { hash: '00'.repeat(32), height, timestamp: new Date().toISOString(), mining_pool: { id: 1, name: pool }, analysis: {} } });
  return [t(EXCLUDED, 'x1'), t(CONTROL, 'y1'), block(EXCLUDED, H + 1), block(CONTROL, H + 2), { type: 'end-of-test' }];
}

async function callStream(): Promise<{ status: number; text: string; body: unknown }> {
  let onMessage: ((msg: { content: Buffer } | null) => void) | undefined;
  const channel = {
    assertQueue: vi.fn(async () => ({ queue: 'q' })), bindQueue: vi.fn(async () => {}),
    consume: vi.fn(async (_q: string, cb: typeof onMessage) => { onMessage = cb; return { consumerTag: 't' }; }),
    ack: vi.fn(), cancel: vi.fn(async () => {}), deleteQueue: vi.fn(async () => {}), close: vi.fn(async () => {}),
  };
  vi.doMock('../rabbitmq', () => ({
    RABBITMQ_EXCHANGES: ['x'],
    createRabbitmqChannel: vi.fn(async () => ({ channel, connection: { close: vi.fn(async () => {}) } })),
  }));
  try {
    const { GET } = await import('../../app/api/stream/route');
    const abort = new AbortController();
    const res = await GET(new NextRequest('http://localhost/api/stream', { signal: abort.signal }));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);   // the connection message; the consumer is set up by now
    for (const m of streamMessages()) onMessage!({ content: Buffer.from(JSON.stringify(m)) });
    while (!text.includes('end-of-test')) text += decoder.decode((await reader.read()).value);
    abort.abort();
    const body = text.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
    return { status: res.status, text, body };
  } finally {
    vi.doUnmock('../rabbitmq');
  }
}

/** One route, loaded fresh (the blacklist, flags and route caches are read at import) with this blacklist. */
async function call(route: string, c: Case, blacklist: string): Promise<{ status: number; text: string; body: unknown }> {
  vi.resetModules();
  const g = globalThis as Record<string, unknown>;
  for (const k of ['__templateSetEpochs', '__forksSummaries', '__forksCardBlocks', '__forkLanes']) delete g[k];
  Object.assign(process.env, {
    PG_HOST: env.PG_TEST_HOST, PG_PORT: env.PG_TEST_PORT ?? '5432', PG_DATABASE: env.PG_TEST_DATABASE ?? 'stratum',
    PG_USER: env.PG_TEST_USER, PG_PASSWORD: env.PG_TEST_PASSWORD, PG_SSLMODE: 'disable',
    POOL_BLACKLIST: blacklist, ENABLE_HISTORICAL_DATA: 'true', EXTRANONCE1_MASK_KEY: 'exclusion-test-key',
  });
  try {
    if (route === 'stream') return await callStream();
    const file = pathToFileURL(join(API_DIR, route, 'route.ts')).href;
    const m = await import(/* @vite-ignore */ file);
    const req = new NextRequest(`http://localhost/api/${route}${c.qs ? `?${c.qs}` : ''}`);
    const res: Response = await m.GET(req, { params: Promise.resolve(c.params ?? {}) });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* not JSON: the text check below still applies */ }
    return { status: res.status, text, body };
  } finally {
    const pg = (global as unknown as { stratumPgPool?: { end(): Promise<void> } });
    await pg.stratumPgPool?.end();
    delete pg.stratumPgPool;
  }
}

describe('POOL_BLACKLIST exclusion invariant: route discovery', () => {
  it('finds the routes under app/api', () => {
    expect(discoverRoutes()).toEqual(expect.arrayContaining(['blocks', 'forks', 'template-providers', 'tx/[txid]']));
  });
  it('every route has a case here, and every case a route', () => {
    expect(Object.keys(cases()).sort()).toEqual(discoverRoutes());
  });
});

describe.skipIf(!enabled)('POOL_BLACKLIST exclusion invariant (every API route, real database)', () => {
  const run = Math.floor(Date.now() / 1000) % 40_000;
  const E = 5_500 + (run % 400);                 // above every other suite's epochs (pgTemplateProviders: 4,900 +)
  H = E * 2016 + 100;
  const ID = 970_000 + (run % 1000) * 10;
  const [PX, PY] = [ID + 1, ID + 2];
  const NOW = Math.floor(Date.now() / 1000);
  const BITS = 0x207fffff;
  const r3 = run.toString(16).padStart(6, '0');
  const hash = (k: string) => '00' + r3 + k.repeat(24) + 'ffffffff';   // display order; meets BITS read this way only
  const [B2, B1, B0] = [hash('b2'), hash('b1'), hash('b0')];
  S = hash('5e'); U = hash('3a'); UX = hash('3b');
  TXID = 'ee'.repeat(32);
  const SITE = `zz-excl-${run}`;
  const tagHex = Buffer.from(`/${EXCLUDED}/`).toString('hex');
  const cb1 = (tag = '') => '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff'
    + (4 + tag.length / 2 + 8).toString(16).padStart(2, '0') + '0340420f' + tag;
  const CB2 = 'ffffffff0100f2052a01000000016a00000000';
  let admin: Client;
  const sid: Record<string, number> = {};

  const block = (h: string, height: number, at: number, pool: number, o: { analysis?: object } = {}) => admin.query(
    `INSERT INTO blocks (block_hash, height, block_time, seen_at, coinbase_script_sig, pool_id, mining_pool, analysis, bits)
     VALUES (decode($1, 'hex'), $2, to_timestamp($3), to_timestamp($3), '\\x00', $4, $5::jsonb, $6::jsonb, $7)`,
    [h, height, at, pool, JSON.stringify({ id: pool, name: pool === PX ? EXCLUDED : CONTROL }), JSON.stringify(o.analysis ?? {}), BITS]);
  let job = 0;
  const tpl = (feed: string, height: number, at: number, parent: string, o: { cb1?: string; branch?: string } = {}) => admin.query(
    `INSERT INTO templates (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2, merkle_branches,
                            version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length)
     VALUES (to_timestamp($1::float8), $2, $3, $4, stratum_prev_hash_to_block_hash(decode($5, 'hex')), decode($6, 'hex'),
             decode($7, 'hex'), decode($8, 'hex'), 536870912, $9, $10, true, decode('c0ffee01', 'hex'), 4)`,
    [at, sid[feed], height, `j${++job}`, parent, o.cb1 ?? cb1(), CB2, o.branch ?? '11'.repeat(32), BITS, 1_790_000_000 + job]);

  async function cleanup() {
    const hs = [U, UX, S];
    await admin.query(`DELETE FROM unknown_parent_pools WHERE prev_hash = ANY (SELECT stratum_prev_hash_to_block_hash(decode(h, 'hex')) FROM unnest($1::text[]) h)`, [hs]);
    await admin.query(`DELETE FROM stale_parent_pools WHERE prev_hash = ANY (SELECT stratum_prev_hash_to_block_hash(decode(h, 'hex')) FROM unnest($1::text[]) h)`, [hs]);
    for (const t of ['template_set_pairs', 'template_set_feeds', 'template_set_heights']) {
      await admin.query(`DELETE FROM ${t} WHERE height BETWEEN $1 AND $2`, [E * 2016, E * 2016 + 2015]);
    }
    await admin.query(`DELETE FROM templates WHERE source_id IN (SELECT id FROM sources WHERE site = $1)`, [SITE]);
    await admin.query(`DELETE FROM sources WHERE site = $1`, [SITE]);
    await admin.query(`DELETE FROM stale_blocks WHERE block_hash = decode($1, 'hex')`, [S]);
    await admin.query(`DELETE FROM blocks WHERE height BETWEEN $1 AND $2`, [H - 2, H + 1]);
    await admin.query(`DELETE FROM pools WHERE id IN ($1, $2)`, [PX, PY]);
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: env.PG_TEST_ADMIN_DSN });
    await admin.connect();
    await admin.query('SELECT pg_advisory_lock($1)', [TIP_LOCK]);   // released when admin disconnects (afterAll)
    await cleanup();
    for (const [id, name] of [[PX, EXCLUDED], [PY, CONTROL]] as const) {
      await admin.query(`INSERT INTO pools (id, name, tags, definition) VALUES ($1, $2, $3, $4::jsonb)`,
        [id, name, [`/${name}/`], JSON.stringify({ id, name, tag: `/${name}/` })]);
    }
    for (const feed of [EXCLUDED, CONTROL]) {
      sid[feed] = (await admin.query(`INSERT INTO sources (name, site, replica) VALUES ($1, $2, 'a') RETURNING id`, [feed, SITE])).rows[0].id;
    }
    // the chain: the tip B(H) arrived two minutes ago (recent: the realtime pre-fill reads H and H + 1)
    const offenders = [EXCLUDED, CONTROL].map(p => ({ pool_name: p, total_sats: 330_000_000, subsidy_sats: 312_500_000 }));
    await block(B2, H - 2, NOW - 1800, PX);
    await block(B1, H - 1, NOW - 1200, PY);
    await block(B0, H, NOW - 120, PY,
      { analysis: { flags: [{ key: 'invalid_coinbase_no_merkle', icon: 'error', details: { offenders } }] } });
    // S: a stale block at H - 1 mined by the excluded pool
    await admin.query(
      `INSERT INTO stale_blocks (block_hash, height, prev_hash, version, block_time, bits, nonce, merkle_root,
                                 chaintip_status, last_status, tip_hash, fork_height, first_seen, mining_pool)
       VALUES (decode($1, 'hex'), $2, decode($3, 'hex'), 1, to_timestamp($4), $5, 1, '\\x00', 'valid-fork',
               'valid-fork', decode($1, 'hex'), $2 - 1, to_timestamp($4), $6::jsonb)`,
      [S, H - 1, B2, NOW - 1190, BITS, JSON.stringify({ id: PX, name: EXCLUDED })]);
    // templates at H - 1 (on B(H-2)), at H (on B(H-1), S, U, UX) and at H + 1 (on the tip)
    for (const feed of [EXCLUDED, CONTROL]) await tpl(feed, H - 1, NOW - 1500, B2);
    await tpl(EXCLUDED, H, NOW - 1150, B1);
    await tpl(CONTROL, H, NOW - 1140, B1, { cb1: cb1(tagHex) });            // the control feed pays the excluded pool
    await tpl(CONTROL, H, NOW - 1100, B1, { cb1: cb1(tagHex), branch: '22'.repeat(32) });
    for (const feed of [EXCLUDED, CONTROL]) {
      await tpl(feed, H, NOW - 1180, S);
      await tpl(feed, H, NOW - 1000, U);
      await tpl(feed, H, NOW - 990, U, { branch: '33'.repeat(32) });
    }
    await tpl(EXCLUDED, H, NOW - 900, UX);
    for (const feed of [EXCLUDED, CONTROL]) await tpl(feed, H + 1, NOW - 60, B0);
    // the forks summaries, as the backend writes them
    await admin.query(
      `SELECT unknown_parent_pools_refresh(x.prev_hash, x.heights, x.t_from, x.t_to)
         FROM (SELECT prev_hash, array_agg(DISTINCT height) AS heights, min(received_at) AS t_from, max(received_at) AS t_to
                 FROM templates WHERE prev_hash = ANY (SELECT stratum_prev_hash_to_block_hash(decode(h, 'hex')) FROM unnest($1::text[]) h)
                GROUP BY prev_hash) x`, [[U, UX]]);
    await admin.query(
      `SELECT stale_parent_pools_refresh(s.block_hash, s.height + 1, w.w_from, w.w_to)
         FROM stale_blocks s CROSS JOIN LATERAL template_height_windows(s.height + 1, s.height + 1) w
        WHERE s.block_hash = decode($1, 'hex')`, [S]);
    // transaction-set counts (template providers): the control feed's templates pay both pools; they share sets with
    // the excluded feed
    const T = NOW - 1000;
    for (const h of [H - 1, H]) {
      await admin.query(`INSERT INTO template_set_heights (height, templates) VALUES ($1, 30)`, [h]);
      for (const [feed, pool, sets] of [[EXCLUDED, PX, 10], [CONTROL, PY, 10], [CONTROL, PX, 5]] as const) {
        await admin.query(
          `INSERT INTO template_set_feeds (height, feed, pool_id, sets, templates, first_received, last_received)
           VALUES ($1, $2, $3, $4, $4, to_timestamp($5), to_timestamp($5))`, [h, feed, pool, sets, T]);
      }
      // a < b in (feed, pool_id) order: ControlPoolY < ExcludedPoolX
      for (const [fa, pa, fb, pb, shared] of [[CONTROL, PY, EXCLUDED, PX, 8], [CONTROL, PX, EXCLUDED, PX, 5], [CONTROL, PX, CONTROL, PY, 4]] as const) {
        await admin.query(`INSERT INTO template_set_pairs (height, feed_a, pool_a, feed_b, pool_b, shared) VALUES ($1, $2, $3, $4, $5, $6)`,
          [h, fa, pa, fb, pb, shared]);
      }
    }
  }, 120_000);                                   // may wait for another suite's tip lock

  afterAll(async () => {
    if (!admin) return;
    await cleanup();
    await admin.end();
  });

  const all = () => Object.entries(cases()).flatMap(([route, cs]) => cs.map(c => ({ route, c })));

  it('covers every route with at least one case', () => {
    expect(all().length).toBeGreaterThanOrEqual(discoverRoutes().length);
  });

  // it.each needs the cases at collection time, before beforeAll has set H: iterate inside one test per route instead.
  for (const route of discoverRoutes()) {
    it(`/api/${route}`, async () => {
      const cs = cases()[route];
      expect(cs, `no case for /api/${route}: add one to cases()`).toBeDefined();
      for (const c of cs) {
        const label = `/api/${route}${c.qs ? `?${c.qs}` : ''}`;
        const open = await call(route, c, '');
        expect(open.status, `${label} without a blacklist: ${open.text.slice(0, 300)}`).toBe(200);
        if (!c.noPoolData) {
          expect(EXCLUDED_RE.test(open.text), `${label}: the seed doesn't reach this case (no ${EXCLUDED} without a blacklist)`).toBe(true);
        }

        const shut = await call(route, c, EXCLUDED);
        expect(shut.status, `${label}: ${shut.text.slice(0, 300)}`).toBe(200);
        const paths = namePaths(shut.body);
        // every occurrence in the text is at a JSON path (nothing outside the parsed body)
        expect(EXCLUDED_RE.test(shut.text), `${label}: the name is in the text but at no JSON path`).toBe(paths.length > 0);
        const allowed = new Set((c.allow ?? []).map(a => a.path));
        expect([...new Set(paths)].filter(p => !allowed.has(p)), `${label} names the excluded pool`).toEqual([]);
        const unhit = [...allowed].filter(p => !paths.includes(p));
        expect(unhit, `${label}: allowlist entries no longer needed (remove them)`).toEqual([]);
        if (!c.noPoolData) expect(CONTROL_RE.test(shut.text), `${label}: the control pool is missing`).toBe(true);
      }
    }, 60_000);
  }
});
