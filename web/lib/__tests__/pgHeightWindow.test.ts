/**
 * Height reads bound receive time (lib/db/postgres.ts, height_window() in db/migrations/20261118000006): a template
 * for height h is received between the blocks at h - 1 and h arriving, with a 2 h margin. Against a real, migrated
 * database as a user in the stratum_web role; skipped unless one is configured, like the other pg*.test.ts:
 *
 *   PG_TEST_HOST=… PG_TEST_USER=web PG_TEST_PASSWORD=… PG_TEST_ADMIN_DSN=postgresql://… npm test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

const env = process.env;
const enabled = !!env.PG_TEST_HOST;

describe.skipIf(!enabled)('Postgres height reads: only the height receive window', () => {
  const h = 600_000 + (Math.floor(Date.now() / 1000) % 50_000) * 3;   // unique per run, away from the other tests
  const pool = `wwin-${h}`;
  const staleOnly = `wwin-stale-${h}`;
  const T0 = 1_794_600_000;                                            // block h - 1 arrives at T0, block h 10 min later
  let pg: typeof import('../db/postgres');
  let admin: Client;
  const sid: Record<string, number> = {};

  const insert = (src: string, at: number, job: string) =>
    admin.query(
      `INSERT INTO templates (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2, merkle_branches,
                              version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length)
       VALUES (to_timestamp($1::float8), $2, $3, $4, '\\x11', '\\x01', '\\x02', '', 1, 2, 3, true, '\\x03', 8)`,
      [at, sid[src], h, job]);

  beforeAll(async () => {
    Object.assign(process.env, {
      PG_HOST: env.PG_TEST_HOST, PG_PORT: env.PG_TEST_PORT ?? '5432', PG_DATABASE: env.PG_TEST_DATABASE ?? 'stratum',
      PG_USER: env.PG_TEST_USER, PG_PASSWORD: env.PG_TEST_PASSWORD, PG_SSLMODE: 'disable',
    });
    pg = await import('../db/postgres');
    admin = new Client({ connectionString: env.PG_TEST_ADMIN_DSN });
    await admin.connect();
    for (const [height, at] of [[h - 1, T0], [h, T0 + 600]]) {
      await admin.query(
        `INSERT INTO blocks (block_hash, height, block_time, seen_at, coinbase_script_sig)
         VALUES (decode(lpad(to_hex($1::bigint), 64, '0'), 'hex'), $1, to_timestamp($2::float8), to_timestamp($2::float8), '\\x00')`,
        [height, at]);
    }
    for (const name of [pool, staleOnly]) {
      const r = await admin.query(
        `INSERT INTO sources (name, site) VALUES ($1, 'ci') ON CONFLICT (name, site, replica) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`, [name]);
      sid[name] = r.rows[0].id;
    }
    await insert(pool, T0 + 5, 'current');
    await insert(pool, T0 + 86_400, 'stale');          // a stuck feed re-sending h's job a day later
    await insert(staleOnly, T0 + 172_800, 'stale2');  // a source whose only row at h is two days late
  });

  afterAll(async () => {
    await admin?.end();
    const { getPgPool } = await import('../db/pg');
    await getPgPool().end();
  });

  const jobId = (t: { id: string }) => t.id.split('-').pop();

  it('R1 shows only the rows received inside the window', async () => {
    const got = await pg.templatesAtHeight(h);
    expect(got.filter(t => t.pool_name === pool).map(jobId)).toEqual(['current']);
    expect(got.some(t => t.pool_name === staleOnly)).toBe(false);
  });

  it('R2 (template details) still shows every row at the height', async () => {
    const got = await pg.allTemplatesAtHeight(h);
    expect(got.filter(t => t.pool_name === pool || t.pool_name === staleOnly).map(jobId).sort())
      .toEqual(['current', 'stale', 'stale2']);
  });

  it('R4 first seen and R4b pool names ignore late rows', async () => {
    const first = await pg.firstSeenByPool(h);
    expect(first.map(f => f.poolName)).toContain(pool);
    expect(first.map(f => f.poolName)).not.toContain(staleOnly);
    const names = await pg.poolNamesAtHeight(h);
    expect(names).toContain(pool);
    expect(names).not.toContain(staleOnly);
  });

  it('isHeightFinal: closed window (block h long ago) is final; above the stored tip is not', async () => {
    expect(await pg.isHeightFinal(h)).toBe(true);              // block h arrived in 2026-11 test time, + 2 h passed
    expect(await pg.isHeightFinal(10_000_000)).toBe(false);    // no block: window open-ended
  });
});
