/**
 * /api/block-template-matches (#235) against a real, migrated database, as a user in the stratum_web role, on the
 * synthetic block of db/test-block-template-matches.sql (generated from backend/coinbase.py: a coinbase and 7
 * transactions, 3 branches; and an empty block), moved to this suite's own heights and source names:
 *  - Winner's two connections and Sharer carry exactly the block's set: verified, by first receive time; Winner's
 *    coinbase brackets fit (both connections), Sharer's don't ("set only"); Partial (2 of 3 branches) isn't listed.
 *  - the first copy's own latency estimate is served with it (Winner a's), none for a copy without one.
 *  - the empty block proves nothing; a height without a block has no blocks; job ids are never served.
 * Holds TIP_LOCK (like pgForks and pgExclusionInvariant) while its blocks exist. Skipped unless a test database is
 * configured:
 *
 *   PG_TEST_HOST=… PG_TEST_USER=web PG_TEST_PASSWORD=… PG_TEST_ADMIN_DSN=postgresql://… npm test
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';

const env = process.env;
const enabled = !!env.PG_TEST_HOST;
const TIP_LOCK = 72_010_261;

describe.skipIf(!enabled)('Postgres block template matches (synthetic block)', () => {
  const run = Math.floor(Date.now() / 1000) % 40_000;
  const H1 = 3_000_000 + run * 4, H2 = H1 + 1;
  const sfx = `-m${run}`;
  const names = ['Winner', 'Sharer', 'Partial', 'Other'].map(n => n + sfx);
  let admin: Client;
  let route: typeof import('../../app/api/block-template-matches/route');

  beforeAll(async () => {
    vi.resetModules();
    Object.assign(process.env, {
      PG_HOST: env.PG_TEST_HOST, PG_PORT: env.PG_TEST_PORT ?? '5432', PG_DATABASE: env.PG_TEST_DATABASE ?? 'stratum',
      PG_USER: env.PG_TEST_USER, PG_PASSWORD: env.PG_TEST_PASSWORD, PG_SSLMODE: 'disable', POOL_BLACKLIST: '',
    });
    admin = new Client({ connectionString: env.PG_TEST_ADMIN_DSN });
    await admin.connect();
    await admin.query('SELECT pg_advisory_lock($1)', [TIP_LOCK]);
    // the SQL test's seed (everything before its checks), at this suite's heights and names
    const sql = readFileSync(fileURLToPath(new URL('../../../db/test-block-template-matches.sql', import.meta.url)), 'utf8');
    let seed = sql.slice(0, sql.indexOf('DO $$'))
      .replaceAll('975501', String(H1)).replaceAll('975502', String(H2))
      .replaceAll('5c783031', (H1 % 0xffffff).toString(16).padStart(6, '0') + '31')
      .replaceAll('5c783032', (H1 % 0xffffff).toString(16).padStart(6, '0') + '32');
    for (const n of ['Winner', 'Sharer', 'Partial', 'Other']) seed = seed.replaceAll(`'${n}'`, `'${n}${sfx}'`).replaceAll(`"${n}"`, `"${n}${sfx}"`);
    await admin.query(seed);
    // Winner a's first copy has a latency estimate; the re-send (30 s later) has another one, which must not be used
    await admin.query(
      `UPDATE templates t SET latency_ms = CASE WHEN t.job_id = 'w1' AND t.received_at = (SELECT min(received_at) FROM templates x
         WHERE x.source_id = t.source_id AND x.height = $1) THEN 12.5 ELSE 99 END, latency_method = 'tcp'
        FROM sources s WHERE s.id = t.source_id AND s.name = $2 AND s.replica = '0' AND t.height = $1`, [H1, names[0]]);
    route = await import('../../app/api/block-template-matches/route');
  });

  afterAll(async () => {
    await admin?.query(`DELETE FROM templates WHERE height IN ($1, $2)`, [H1, H2]);
    await admin?.query(`DELETE FROM blocks WHERE height IN ($1, $2)`, [H1, H2]);
    await admin?.query(`DELETE FROM sources WHERE name = ANY ($1::text[])`, [names]);
    await admin?.end();
  });

  const get = async (h: number) => (await route.GET(new Request(`http://localhost/api/block-template-matches?height=${h}`))).json();

  it('lists every verified match by first receive time, with its coinbase fit and its own latency', async () => {
    const body = await get(H1);
    expect(body.blocks).toHaveLength(1);
    const [b] = body.blocks;
    expect(b).toMatchObject({ pool: names[0], state: 'verified', transactions_known: true, coinbase_known: true, closest: null, seen_ms: null });
    expect(b.hash).toMatch(/^0{50}/);                                            // display order, as stored
    expect(b.matches.map((m: { pool: string; connection: string; coinbase: string; templates: number; lat_ms: number | null }) =>
      [m.pool, m.connection, m.coinbase, m.templates, m.lat_ms])).toEqual([
      [names[0], 'a', 'coinbase', 2, 12.5],
      [names[1], 'a', 'merkle', 1, null],
      [names[0], 'b', 'coinbase', 1, null],
    ]);
    expect(JSON.stringify(body)).not.toMatch(/job_id|"w1"|"s1"/);
  });

  it('an empty block proves nothing; no block, no blocks', async () => {
    expect((await get(H2)).blocks[0]).toMatchObject({ state: 'empty_block', matches: [] });
    expect((await get(H2 + 1)).blocks).toEqual([]);
  });
});
