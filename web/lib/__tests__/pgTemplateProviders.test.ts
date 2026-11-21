/**
 * /api/template-providers (app/api/template-providers/route.ts; lib/db/template-providers.ts, lib/templateProviders.ts)
 * against a real, migrated database, as a user in the stratum_web role. Seeds, as the owner, the backend's counts
 * (template_set_heights / _feeds / _pairs, written in production by backend/template_sets.py) for two difficulty
 * epochs, our best-chain blocks with their pools, and the pools' names:
 *   E0  feeds fa (pool A) and fb (pool B) share a provider; fc (pool C) builds its own; fx (pool B too, more sets than
 *       fb, and sharing with fc) is the excluded feed
 *   E1  fa and fb apart
 *   blocks by A, B, C, a pool no feed pays (Z), an unidentified one, and a miner-built one (a DATUM creator), plus one
 *       above the last counted epoch
 * Checks the columns and pies, names from pools, kinds, POOL_BLACKLIST (the excluded feed's output equals that of a
 * database where it never existed, and its name appears nowhere), and that the web role can't write the tables.
 *
 * Holds TIP_LOCK (as pgForks and pgBlocksBest do) while its blocks, above every other suite's, exist. Skipped unless
 * a test database is configured:
 *
 *   PG_TEST_HOST=… PG_TEST_USER=web PG_TEST_PASSWORD=… PG_TEST_ADMIN_DSN=postgresql://… npm test
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';

const env = process.env;
const enabled = !!env.PG_TEST_HOST;
const TIP_LOCK = 72_010_261;                // the same key in pgForks.test.ts and pgBlocksBest.test.ts

describe.skipIf(!enabled)('Postgres template providers', () => {
  const run = Math.floor(Date.now() / 1000) % 40_000;
  const E0 = 4_900 + (run % 50), E1 = E0 + 1;
  const h0 = E0 * 2016, h1 = E1 * 2016;
  const tag = `wtp${run}`;
  const [fa, fb, fc, fx] = ['a', 'b', 'c', 'x'].map(f => `${tag}-${f}`);
  const ID = 980_000 + (run % 1000) * 10;
  const [A, B, C, X, Z] = [ID + 1, ID + 2, ID + 3, ID + 4, ID + 5];
  const NAME: Record<number, string> = { [A]: `${tag} Pool A`, [B]: `${tag} Pool B`, [C]: `${tag} Pool C`, [X]: `${tag} Pool X`, [Z]: `${tag} Pool Z` };
  const T0 = 1_790_000_000;
  let admin: Client;
  const heights: number[] = [];

  const feedRow = (h: number, feed: string, pool: number | null, sets: number) => admin.query(
    `INSERT INTO template_set_feeds (height, feed, pool_id, sets, templates, first_received, last_received)
     VALUES ($1, $2, $3, $4, $4, to_timestamp($5), to_timestamp($5))`, [h, feed, pool, sets, T0]);
  const pairRow = (h: number, a: string, pa: number | null, b: string, pb: number | null, shared: number) => admin.query(
    `INSERT INTO template_set_pairs (height, feed_a, pool_a, feed_b, pool_b, shared) VALUES ($1, $2, $3, $4, $5, $6)`,
    [h, a, pa, b, pb, shared]);
  const block = (height: number, pool: number | null, creator?: string) => admin.query(
    `INSERT INTO blocks (block_hash, height, block_time, seen_at, coinbase_script_sig, pool_id, mining_pool)
     VALUES (decode($1, 'hex'), $2, to_timestamp($3), to_timestamp($3), '\\x00', $4, $5::jsonb)`,
    [(height.toString(16).padStart(16, '0') + 'ab'.repeat(24)), height, T0 + (height - h0) * 600, pool,
     JSON.stringify(pool === null ? { name: 'Unknown', id: 'unknown' } : { name: NAME[pool], id: pool, ...(creator ? { datum_template_creator: creator } : {}) })]);

  async function route(blacklist: string) {
    vi.resetModules();
    // cold: these tests edit the rows directly, without the backend's re-fill (new filled_at) the cache keys on
    delete (globalThis as { __templateSetEpochs?: unknown }).__templateSetEpochs;
    Object.assign(process.env, {
      PG_HOST: env.PG_TEST_HOST, PG_PORT: env.PG_TEST_PORT ?? '5432', PG_DATABASE: env.PG_TEST_DATABASE ?? 'stratum',
      PG_USER: env.PG_TEST_USER, PG_PASSWORD: env.PG_TEST_PASSWORD, PG_SSLMODE: 'disable', POOL_BLACKLIST: blacklist,
      POOL_OWN_TEMPLATE_CREATORS: 'OWN',
    });
    const m = await import('../../app/api/template-providers/route');
    const res = await m.GET(new Request('http://localhost/api/template-providers'));
    const body = await res.json();
    const { getPgPool } = await import('../db/pg');
    await getPgPool().end();
    delete (global as unknown as { stratumPgPool?: unknown }).stratumPgPool;   // the next import connects afresh
    return { status: res.status, body };
  }

  async function cleanup() {
    for (const t of ['template_set_pairs', 'template_set_feeds', 'template_set_heights']) {
      await admin.query(`DELETE FROM ${t} WHERE height BETWEEN $1 AND $2`, [h0, h1 + 2015]);
    }
    await admin.query(`DELETE FROM blocks WHERE height BETWEEN $1 AND $2`, [h0 - 1, h1 + 2100]);
    await admin.query(`DELETE FROM pools WHERE id BETWEEN $1 AND $2`, [ID, ID + 9]);
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: env.PG_TEST_ADMIN_DSN });
    await admin.connect();
    await admin.query('SELECT pg_advisory_lock($1)', [TIP_LOCK]);   // released when admin disconnects (afterAll)
    await cleanup();
    for (const id of [A, B, C, X, Z]) {
      await admin.query(`INSERT INTO pools (id, name, definition) VALUES ($1, $2, $3::jsonb)`, [id, NAME[id], JSON.stringify({ id, name: NAME[id] })]);
    }
    // E0: two heights of counts
    for (const h of [h0 + 10, h0 + 11]) {
      heights.push(h);
      await admin.query(`INSERT INTO template_set_heights (height, templates) VALUES ($1, 100)`, [h]);
      await feedRow(h, fa, A, 10); await feedRow(h, fb, B, 10); await feedRow(h, fc, C, 10); await feedRow(h, fx, B, 20);
      await feedRow(h, fx, null, 3); await feedRow(h, fx, X, 6);
      await pairRow(h, fa, A, fb, B, 9);
      await pairRow(h, fc, C, fx, B, 10);       // only with fx present: fc joins fx (and B's blocks follow fx)
      await pairRow(h, fx, null, fx, B, 3);
      await pairRow(h, fx, B, fx, X, 6);
    }
    // E1: apart
    heights.push(h1 + 5);
    await admin.query(`INSERT INTO template_set_heights (height, templates) VALUES ($1, 50)`, [h1 + 5]);
    await feedRow(h1 + 5, fa, A, 10); await feedRow(h1 + 5, fb, B, 10);
    await pairRow(h1 + 5, fa, A, fb, B, 2);
    // blocks: E0 A, A, B, C, Z (on no feed), unidentified, a miner-built one via C, one by C's own template server
    await block(h0 + 1, A); await block(h0 + 2, A); await block(h0 + 3, B); await block(h0 + 4, C);
    await block(h0 + 5, Z); await block(h0 + 6, null); await block(h0 + 7, C, 'miner-q'); await block(h0 + 8, C, 'OWN-2');
    await block(h0 + 9, X);                    // paid only on the excluded feed: "not on our feeds" when it's excluded
    // E1: A, B; above the last counted epoch (E1 + 1): B
    await block(h1 + 1, A); await block(h1 + 2, B); await block(h1 + 2016 + 3, B);
  });

  afterAll(async () => {
    if (!admin) return;
    await cleanup();
    await admin.end();
  });

  it('derives columns, pies and names from the counts', async () => {
    const { status, body } = await route(fx);
    expect(status).toBe(200);
    const mine = (c: { label: string }) => c.label === h0.toLocaleString('en-US') || c.label === h1.toLocaleString('en-US');
    const cols = body.columns.filter(mine);
    expect(cols).toHaveLength(2);
    const g0 = Object.fromEntries(cols[0].groups.map((g: { name: string }) => [g.name, g]));
    expect(g0[`${NAME[A]} +1`]).toMatchObject({ n: 3, pools: [NAME[A], NAME[B]], payers: [NAME[A], NAME[B]], feeds: [fa, fb], hatched: true, kind: 'producer' });
    expect(g0[NAME[C]]).toMatchObject({ n: 2, feeds: [fc], hatched: false });   // its block and its own server's
    expect(g0['Miner-built']).toMatchObject({ n: 1, kind: 'miner', creators: [['miner-q', 1]], via: [[NAME[C], 1]] });
    expect(g0['not on our feeds']).toMatchObject({ n: 2, kind: 'other' });   // Z's, and X's (only fx pays X)
    expect(g0['unidentified']).toMatchObject({ n: 1, kind: 'other' });
    expect(cols[0].tot).toBe(9);
    const g1 = Object.fromEntries(cols[1].groups.map((g: { name: string }) => [g.name, g]));
    expect(Object.keys(g1).sort()).toEqual([NAME[A], NAME[B]].sort());
    expect(body.columns.at(-1).label).toBe('now');
    expect(body.tip_height).toBe(h1 + 2016 + 3);
    const all = body.pies.at(-1);
    expect(all.label).toBe('All');
    expect(all.tot).toBe(12);
    // the block above the last counted epoch counts with E1's groups: B on its own
    expect(body.pies[0].groups.find((g: { pools: string[] }) => g.pools[0] === NAME[B])?.feeds).toEqual([fb]);
    expect(body.heights_counted).toBe(3);
  });

  it('an excluded feed is as if it never existed', async () => {
    const excluded = await route(fx);
    expect(JSON.stringify(excluded.body)).not.toContain(fx);
    expect(JSON.stringify(excluded.body)).not.toContain(NAME[X]);
    // the same database without fx's rows, no blacklist
    const saved = await admin.query(`SELECT * FROM template_set_feeds WHERE feed = $1`, [fx]);
    const savedPairs = await admin.query(`SELECT * FROM template_set_pairs WHERE feed_a = $1 OR feed_b = $1`, [fx]);
    await admin.query(`DELETE FROM template_set_pairs WHERE feed_a = $1 OR feed_b = $1`, [fx]);
    await admin.query(`DELETE FROM template_set_feeds WHERE feed = $1`, [fx]);
    try {
      const without = await route('');
      const strip = (b: Record<string, unknown>) => ({ ...b, generated_at: 0 });
      expect(strip(excluded.body)).toEqual(strip(without.body));
    } finally {
      for (const r of saved.rows) await feedRow(r.height, r.feed, r.pool_id, r.sets);
      for (const r of savedPairs.rows) await pairRow(r.height, r.feed_a, r.pool_a, r.feed_b, r.pool_b, r.shared);
    }
    // and with fx collected, fx is where B's blocks and fc go
    const withX = await route('');
    expect(JSON.stringify(withX.body)).toContain(fx);
    const col = withX.body.columns.find((c: { label: string }) => c.label === h0.toLocaleString('en-US'));
    const bx = col.groups.find((g: { feeds: string[] }) => g.feeds.includes(fx));
    expect(bx.feeds).toEqual([fc, fx]);
    expect(bx.payers).toEqual([NAME[B], NAME[C], NAME[X]].sort());
    expect(bx.pools).toContain(NAME[X]);                                     // X's block is on our feeds now
  });

  it('reads just the asked epochs for Forks\' providers per episode, the excluded feed dropped', async () => {
    vi.resetModules();
    Object.assign(process.env, {
      PG_HOST: env.PG_TEST_HOST, PG_PORT: env.PG_TEST_PORT ?? '5432', PG_DATABASE: env.PG_TEST_DATABASE ?? 'stratum',
      PG_USER: env.PG_TEST_USER, PG_PASSWORD: env.PG_TEST_PASSWORD, PG_SSLMODE: 'disable',
    });
    delete (globalThis as { __templateSetEpochs?: unknown }).__templateSetEpochs;   // cold (the rows were edited above)
    const db = await import('../db/template-providers');
    const { feedProviders, groupEpochs } = await import('../templateProviders');
    try {
      const e0 = await db.getEpochGroupInputs([E0], [fx]);
      expect(e0.counted).toEqual([{ epoch: E0, heights: 2 }]);
      expect(new Set([...e0.nodes, ...e0.pairs].map(r => r.epoch))).toEqual(new Set([E0]));
      expect(JSON.stringify(e0)).not.toContain(fx);
      // the same rows as the home page's read, for that epoch
      const full = await db.getTemplateProviderInputs([fx]);
      const sortRows = <T,>(rs: T[]) => rs.map(r => JSON.stringify(r)).sort();
      expect(sortRows(e0.nodes)).toEqual(sortRows(full.nodes.filter(n => n.epoch === E0)));
      expect(sortRows(e0.pairs)).toEqual(sortRows(full.pairs.filter(p => p.epoch === E0)));

      const both = await db.getEpochGroupInputs([E1, E0, E1 + 1], [fx]);
      const groups = groupEpochs(both.nodes, both.pairs, both.counted);
      expect(feedProviders([fa, fb, fc], groups.get(E0))).toEqual({ providers: 2, provider_groups: [[fa, fb], [fc]] });
      expect(feedProviders([fa, fb], groups.get(E1))).toEqual({ providers: 2, provider_groups: [[fa], [fb]] });
      expect(feedProviders([fa], groups.get(E1 + 1))).toEqual({ providers: null, provider_groups: [] });   // not counted
      // an excluded pool paid by a feed that isn't excluded (X, paid by fx): that node and its pairs are dropped, so
      // nothing is named after it or grouped through it; fx keeps its other nodes
      const noX = await db.getEpochGroupInputs([E0], [NAME[X]]);
      expect(noX.nodes.some(n => n.pool_id === X)).toBe(false);
      expect(noX.pairs.some(p => p.pool_a === X || p.pool_b === X)).toBe(false);
      expect(noX.nodes.some(n => n.feed === fx && n.pool_id === B)).toBe(true);
      const gNoX = groupEpochs(noX.nodes, noX.pairs, noX.counted).get(E0)!;
      expect(gNoX.groups.flatMap(g => g.payers)).not.toContain(X);
      expect(feedProviders([fa, fc, fx], gNoX)).toEqual({ providers: 2, provider_groups: [[fc, fx], [fa]] });
      // collected, fx is a provider with fc
      const withX = await db.getEpochGroupInputs([E0], []);
      const gx = groupEpochs(withX.nodes, withX.pairs, withX.counted).get(E0);
      expect(feedProviders([fa, fc, fx], gx)).toEqual({ providers: 2, provider_groups: [[fc, fx], [fa]] });
    } finally {
      const { getPgPool } = await import('../db/pg');
      await getPgPool().end();
      delete (global as unknown as { stratumPgPool?: unknown }).stratumPgPool;
    }
  });

  it('the shared per-epoch read, after a height is filled, equals a cold read', async () => {
    vi.resetModules();
    Object.assign(process.env, {
      PG_HOST: env.PG_TEST_HOST, PG_PORT: env.PG_TEST_PORT ?? '5432', PG_DATABASE: env.PG_TEST_DATABASE ?? 'stratum',
      PG_USER: env.PG_TEST_USER, PG_PASSWORD: env.PG_TEST_PASSWORD, PG_SSLMODE: 'disable',
    });
    const store = globalThis as { __templateSetEpochs?: unknown };
    delete store.__templateSetEpochs;
    const db = await import('../db/template-providers');
    const sortRows = <T,>(rs: T[]) => rs.map(r => JSON.stringify(r)).sort();
    const mine = (i: { nodes: { epoch: number }[]; pairs: { epoch: number }[]; counted: { epoch: number }[] }) => ({
      counted: i.counted.filter(c => c.epoch === E0 || c.epoch === E1),
      nodes: sortRows(i.nodes.filter(n => n.epoch === E0 || n.epoch === E1)),
      pairs: sortRows(i.pairs.filter(p => p.epoch === E0 || p.epoch === E1)),
    });
    const h = h1 + 6;
    try {
      const before = mine(await db.getEpochGroupInputs([E0, E1], [fx]));
      // the backend fills a height of E1 (heights row and its counts, as replace_template_sets does)
      await admin.query(`INSERT INTO template_set_heights (height, templates) VALUES ($1, 40)`, [h]);
      await feedRow(h, fa, A, 7); await feedRow(h, fc, C, 5); await feedRow(h, fx, B, 9);
      await pairRow(h, fa, A, fc, C, 4); await pairRow(h, fc, C, fx, B, 5);
      const warm = mine(await db.getEpochGroupInputs([E0, E1], [fx]));
      expect(warm).not.toEqual(before);
      expect(warm.counted).toEqual([{ epoch: E0, heights: 2 }, { epoch: E1, heights: 2 }]);
      expect(JSON.stringify(warm)).not.toContain(fx);
      delete store.__templateSetEpochs;
      expect(warm).toEqual(mine(await db.getEpochGroupInputs([E0, E1], [fx])));
    } finally {
      for (const t of ['template_set_pairs', 'template_set_feeds', 'template_set_heights']) {
        await admin.query(`DELETE FROM ${t} WHERE height = $1`, [h]);
      }
      delete store.__templateSetEpochs;
      const { getPgPool } = await import('../db/pg');
      await getPgPool().end();
      delete (global as unknown as { stratumPgPool?: unknown }).stratumPgPool;
    }
  });

  it('the web role reads the tables and cannot write them', async () => {
    const web = new Client({ host: env.PG_TEST_HOST, port: Number(env.PG_TEST_PORT ?? 5432), database: env.PG_TEST_DATABASE ?? 'stratum',
      user: env.PG_TEST_USER, password: env.PG_TEST_PASSWORD });
    await web.connect();
    try {
      for (const t of ['template_set_heights', 'template_set_feeds', 'template_set_pairs']) {
        await web.query(`SELECT count(*) FROM ${t}`);
        await expect(web.query(`DELETE FROM ${t} WHERE height = -1`)).rejects.toThrow(/permission denied/);
      }
    } finally {
      await web.end();
    }
  });
});
