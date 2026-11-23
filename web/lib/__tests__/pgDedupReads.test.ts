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
  const LATE = 86_400;                                                 // a day later: outside every window here
  let pg: typeof import('../db/postgres');
  let admin: Client;
  const sid: Record<string, number> = {};

  // latency: s * 1000 ms (so each row's estimate says which row it is) unless given; method 'tcp' unless given
  const insert = (src: string, s: number, height: number, job: string, br: string, ntime: number, cb: string,
                  lat: number | null = s * 1000, method: string | null = 'tcp') =>
    admin.query(
      `INSERT INTO templates (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2, merkle_branches,
                              version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length, latency_ms, latency_method)
       VALUES (to_timestamp($1::float8), $2, $3, $4, decode(repeat('11', 32), 'hex'), decode($5, 'hex'), '\\xffffffff',
               decode(repeat($6, 32), 'hex'), 536870912, 386000000, $7, true, decode($5, 'hex'), 8, $8, $9::latency_method)`,
      [T0 + s, sid[src], height, job, cb, br, ntime, lat, method]);

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
    // Blocks around the templates (h - 1 at T0, h and h + 1 ten minutes apart): height reads only return rows
    // received inside the height's window (height_window()), as with a real chain.
    for (const [height, at] of [[h - 1, T0], [h, T0 + 600], [h + 1, T0 + 1200]]) {
      await admin.query(
        `INSERT INTO blocks (block_hash, height, block_time, seen_at, coinbase_script_sig)
         VALUES (decode(lpad(to_hex($1::bigint), 64, '0'), 'hex'), $1, to_timestamp($2::float8), to_timestamp($2::float8), '\\x00')
         ON CONFLICT DO NOTHING`, [height, at]);
    }
    // primary ci/a, secondaries ci/b and ci2/a
    await insert('ci/a', 0.020, h, 'a1', 'aa', 100, 'a1');
    await insert('ci/b', 0.010, h, 'b7', 'aa', 100, 'b1', 10, 'app');   // exact copy of a1, earlier: hidden
    await insert('ci2/a', 0.015, h, 'c3', 'aa', 99, 'c1');    // same job, other ntime, ci/a active: hidden
    await insert('ci/a', 30.0, h, 'a2', 'aa', 130, 'a2');     // the primary re-sends the job: shown
    await insert('ci/a', 31.0, h, 'a3', 'ee', 140, 'a3');     // shown; first seen from ci2/a's copy, which has no estimate
    await insert('ci2/a', 30.5, h, 'c4', 'ee', 140, 'c4', null, null);
    await insert('ci/a', 32.0, h, 'a4', 'ff', 150, 'a4', 7);  // shown; ci/b's copy at the same µs: the primary's estimate
    await insert('ci/b', 32.0, h, 'b4', 'ff', 150, 'b4', 70, 'app');
    await insert('ci/b', 5.0, h, 'b8', 'bb', 105, 'b2');      // its own job, ci/a active: hidden (secondary stream)
    await insert('ci/b', 200.0, h, 'b9', 'cc', 300, 'b3');    // ci/a silent for 170 s: shown (gap fill)
    // one collector: a re-send with a new ntime and an exact repeat are all kept
    await insert('single', 1.0, h + 1, 's1', 'aa', 100, 'e1');
    await insert('single', 2.0, h + 1, 's2', 'aa', 101, 'e2');
    await insert('single', 3.0, h + 1, 's3', 'aa', 101, 'e3');
    // another chain's template at this height a day later (unknown parent, outside the height's window), on both
    // connections: an exact copy, so R2 shows it once
    await insert('ci/a', LATE + 2.0, h, 'oa', 'dd', 3, '0a');
    await insert('ci/b', LATE + 1.0, h, 'ob', 'dd', 3, '0a');
  });

  afterAll(async () => {
    await admin?.end();
    const { getPgPool } = await import('../db/pg');
    await getPgPool().end();
  });

  const jobId = (t: { id: string }) => t.id.split('-').pop();   // id = <source_id>-<own µs>-<job_id>
  const us = (s: number) => String(BigInt(Math.round((T0 + s) * 1e6)));
  const hexNs = (s: number) => (BigInt(us(s)) * BigInt(1000)).toString(16);

  it('R1: one stream per pool, gap fills shown; first seen and its latency from the earlier copy', async () => {
    const got = await pg.templatesAtHeight(h);
    expect(got.map(t => [t.pool_name, jobId(t), t.coinbase1, t.ntime, t.timestamp, t.lat_ms, t.lat_m])).toEqual([
      // the primary's own template fields, shown at the secondary's earlier copy with THAT connection's estimate
      // (10 ms, app), not the primary's (20 ms, tcp): the latency-adjusted time is one connection's
      [name, 'a1', 'a1', '00000064', hexNs(0.010), 10, 'app'],
      [name, 'a2', 'a2', '00000082', hexNs(30.0), 30000, 'tcp'],   // no earlier copy: its own
      [name, 'a3', 'a3', '0000008c', hexNs(30.5), null, null],     // the first copy had no estimate: none
      [name, 'a4', 'a4', '00000096', hexNs(32.0), 7, 'tcp'],       // a copy at the same µs: the primary's
      [name, 'b9', 'b3', '0000012c', hexNs(200.0), 200000, 'tcp'], // gap fill: its own
    ]);
    expect(got[0].id).toBe(`${sid['ci/a']}-${us(0.020)}-a1`);   // own receive time in the id
  });

  it('R1: one collector per pool returns the raw rows', async () => {
    const got = await pg.templatesAtHeight(h + 1);
    expect(got.map(t => [jobId(t), t.ntime, t.timestamp, t.id])).toEqual([
      ['s1', '00000064', hexNs(1), `${sid.single}-${us(1)}-s1`],
      ['s2', '00000065', hexNs(2), `${sid.single}-${us(2)}-s2`],
      ['s3', '00000065', hexNs(3), `${sid.single}-${us(3)}-s3`],
    ]);
  });

  it('R2: every row at the height, whenever received, de-duplicated; R1 leaves out the late one', async () => {
    const got = await pg.allTemplatesAtHeight(h);
    expect(got.map(jobId)).toEqual(['a1', 'a2', 'a3', 'a4', 'b9', 'oa']);
    expect(got[5].timestamp).toBe(hexNs(LATE + 1.0));   // first seen: the other connection's earlier exact copy
    expect((await pg.templatesAtHeight(h)).map(jobId)).not.toContain('oa');
  });

  it('R4 / R4b: one entry per pool, first seen over all replicas and sites', async () => {
    const first = await pg.firstSeenByPool(h);
    expect(first).toEqual([{ poolName: name, firstSeenTimestamp: hexNs(0.010), firstSeenLatencyMs: 10 }]);
    expect(await pg.poolNamesAtHeight(h)).toEqual([name]);
  });
});
