/**
 * The Postgres template reads (lib/db/postgres.ts) against a real, migrated database, as a user in the stratum_web
 * role, with several collector replicas of a pool (and a second site): one stream per pool (exact copies and another
 * connection's rows hidden while a lower-ranked source was active; gap fills shown); with one collector the reads
 * return the raw rows. Skipped unless a test database is configured, like
 * backend/tests/test_store.py:
 *
 *   PG_TEST_HOST=… PG_TEST_USER=web PG_TEST_PASSWORD=… PG_TEST_ADMIN_DSN=postgresql://… npm test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

const env = process.env;
const enabled = !!env.PG_TEST_HOST;

describe.skipIf(!enabled)('Postgres template reads with collector replicas', () => {
  const h = 800_000 + (Math.floor(Date.now() / 1000) % 50_000) * 2;   // unique test heights per run (h, h + 1)
  const name = `wtest-${h}`;
  const single = `wtest1-${h}`;
  const T0 = 1_794_437_000;                                            // receive times: T0 + seconds
  let pg: typeof import('../db/postgres');
  let admin: Client;
  const sid: Record<string, number> = {};

  const insert = (src: string, s: number, height: number, job: string, br: string, ntime: number, cb: string) =>
    admin.query(
      `INSERT INTO templates (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2, merkle_branches,
                              version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length, latency_ms, latency_method)
       VALUES (to_timestamp($1::float8), $2, $3, $4, decode(repeat('11', 32), 'hex'), decode($5, 'hex'), '\\xffffffff',
               decode(repeat($6, 32), 'hex'), 536870912, 386000000, $7, true, decode($5, 'hex'), 8, $8, 'tcp')`,
      [T0 + s, sid[src], height, job, cb, br, ntime, s * 1000]);

  beforeAll(async () => {
    Object.assign(process.env, {
      PG_HOST: env.PG_TEST_HOST, PG_PORT: env.PG_TEST_PORT ?? '5432', PG_DATABASE: env.PG_TEST_DATABASE ?? 'stratum',
      PG_USER: env.PG_TEST_USER, PG_PASSWORD: env.PG_TEST_PASSWORD, PG_SSLMODE: 'disable',
    });
    pg = await import('../db/postgres');
    admin = new Client({ connectionString: env.PG_TEST_ADMIN_DSN });   // the web role can't write; insert as admin
    await admin.connect();
    for (const [pool, site, replica] of [[name, 'ci', 'a'], [name, 'ci', 'b'], [name, 'ci2', 'a'], [single, 'ci', 'a']]) {
      const r = await admin.query(
        `INSERT INTO sources (name, site, replica) VALUES ($1, $2, $3)
         ON CONFLICT (name, site, replica) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [pool, site, replica]);
      sid[pool === name ? `${site}/${replica}` : 'single'] = r.rows[0].id;
    }
    // primary ci/a, secondaries ci/b and ci2/a
    await insert('ci/a', 0.020, h, 'a1', 'aa', 100, 'a1');
    await insert('ci/b', 0.010, h, 'b7', 'aa', 100, 'b1');    // exact copy of a1, earlier: hidden
    await insert('ci2/a', 0.015, h, 'c3', 'aa', 99, 'c1');    // same job, other ntime, ci/a active: hidden
    await insert('ci/a', 30.0, h, 'a2', 'aa', 130, 'a2');     // the primary re-sends the job: shown
    await insert('ci/b', 5.0, h, 'b8', 'bb', 105, 'b2');      // its own job, ci/a active: hidden (secondary stream)
    await insert('ci/b', 200.0, h, 'b9', 'cc', 300, 'b3');    // ci/a silent for 170 s: shown (gap fill)
    // one collector: a re-send with a new ntime and an exact repeat are all kept
    await insert('single', 1.0, h + 1, 's1', 'aa', 100, 'e1');
    await insert('single', 2.0, h + 1, 's2', 'aa', 101, 'e2');
    await insert('single', 3.0, h + 1, 's3', 'aa', 101, 'e3');
    for (const [src, s, job] of [['ci/a', 2.0, 'oa'], ['ci/b', 1.0, 'ob']] as const) {
      await admin.query(
        `INSERT INTO templates_other (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2, merkle_branches,
                                      version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length, chain, reason)
         VALUES (to_timestamp($1::float8), $2, $3, $4, '\\x0b', '\\x01', '\\x02', '', 1, 2, 3, true, '\\x03', 8, 'bch', 'bch')`,
        [T0 + s, sid[src], h, job]);
    }
  });

  afterAll(async () => {
    await admin?.end();
    const { getPgPool } = await import('../db/pg');
    await getPgPool().end();
  });

  const jobId = (t: { id: string }) => t.id.split('-').pop();   // id = <source_id>-<own µs>-<job_id>
  const us = (s: number) => String(BigInt(Math.round((T0 + s) * 1e6)));
  const hexNs = (s: number) => (BigInt(us(s)) * BigInt(1000)).toString(16);

  it('R1: one stream per pool, gap fills shown; first seen from the earlier copy', async () => {
    const got = await pg.templatesAtHeight(h);
    expect(got.map(t => [t.pool_name, jobId(t), t.coinbase1, t.ntime, t.lat_ms])).toEqual([
      [name, 'a1', 'a1', '00000064', 20],     // the primary's own fields
      [name, 'a2', 'a2', '00000082', 30000],
      [name, 'b9', 'b3', '0000012c', 200000],
    ]);
    expect(got[0].id).toBe(`${sid['ci/a']}-${us(0.020)}-a1`);   // own receive time in the id
    expect(got[0].timestamp).toBe(hexNs(0.010));                 // shown time: the secondary's earlier copy
  });

  it('R1: one collector per pool returns the raw rows', async () => {
    const got = await pg.templatesAtHeight(h + 1);
    expect(got.map(t => [jobId(t), t.ntime, t.timestamp, t.id])).toEqual([
      ['s1', '00000064', hexNs(1), `${sid.single}-${us(1)}-s1`],
      ['s2', '00000065', hexNs(2), `${sid.single}-${us(2)}-s2`],
      ['s3', '00000065', hexNs(3), `${sid.single}-${us(3)}-s3`],
    ]);
  });

  it('R2: both tables de-duplicated', async () => {
    const got = await pg.allTemplatesAtHeight(h);
    expect(got.map(t => [jobId(t), t.chain_family])).toEqual([['a1', null], ['oa', 'bch'], ['a2', null], ['b9', null]]);
    expect(got[1].timestamp).toBe(hexNs(1.0));
  });

  it('R4 / R4b: one entry per pool, first seen over all replicas and sites', async () => {
    const first = await pg.firstSeenByPool(h);
    expect(first).toEqual([{ poolName: name, firstSeenTimestamp: hexNs(0.010), firstSeenLatencyMs: 10 }]);
    expect(await pg.poolNamesAtHeight(h)).toEqual([name]);
  });
});
