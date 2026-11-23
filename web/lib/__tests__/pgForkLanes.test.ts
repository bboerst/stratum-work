/**
 * The Forks rows' timeline (lib/forkLanes.ts, lib/db/fork-lanes.ts) against a real, migrated database, as a user in the
 * stratum_web role. A race at height H: our best block B1 at H - 1 and a recorded stale block S1 beside it.
 *  - pool `two` has two connections that disagree: a (its primary stream) builds on S1, b on B1 at the same moment.
 *    The timeline is one stream per pool (templates_dedup), so the pool doesn't flap between parents.
 *  - pool `one` sends an empty template paying more than the subsidy, which the finding on B0 (height H) names: one
 *    invalid run, then valid work again. Another empty template of its, paying exactly the subsidy, isn't invalid.
 *  - each lane ends when its pool first worked on the next height; a pool with none there ends at its own last template.
 *  - the excluded pool is left out of everything.
 * Skipped unless a test database is configured:
 *
 *   PG_TEST_HOST=… PG_TEST_USER=web PG_TEST_PASSWORD=… PG_TEST_ADMIN_DSN=postgresql://… npm test
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';

const env = process.env;
const enabled = !!env.PG_TEST_HOST;

describe.skipIf(!enabled)('Postgres fork timeline (one height, runs per pool)', () => {
  const run = Math.floor(Date.now() / 1000) % 40_000;
  const one = `lane1-${run}`, two = `lane2-${run}`, hidden = `lanex-${run}`;
  const H = 7_500_000 + run * 20;
  const T0 = Math.floor(Date.now() / 1000) - 40 * 86_400;
  const BITS = 0x207fffff;
  const r3 = run.toString(16).padStart(6, '0');
  const blk = (k: string) => '0000' + r3 + k.repeat(26) + '00';
  const [B2, B1, B0, S1] = [blk('c2'), blk('c1'), blk('c0'), blk('5c')];
  const SITE = `zz-lanes-${run}`;
  // a coinbase with a 4-byte extranonce2 paying `sats` to OP_TRUE
  const CB1 = '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff0c0340420f';
  const cb2 = (sats: number) => 'ffffffff01' + Buffer.from(new BigUint64Array([BigInt(sats)]).buffer).toString('hex') + '015100000000';
  const SUBSIDY = 312_500_000;
  let admin: Client;
  const sid: Record<string, number> = {};
  let lanes: typeof import('../forkLanes');

  const insert = (src: string, s: number, height: number, job: string, parent: string, o: { empty?: boolean; paid?: number; ntime?: number } = {}) =>
    admin.query(
      `INSERT INTO templates (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2, merkle_branches,
                              version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length)
       VALUES (to_timestamp($1::float8), $2, $3, $4, stratum_prev_hash_to_block_hash(decode($5, 'hex')), decode($6, 'hex'),
               decode($7, 'hex'), decode($8, 'hex'), 536870912, $9, $10, true, decode('c0ffee00', 'hex'), 4)`,
      [T0 + s, sid[src], height, job, parent, CB1, cb2(o.paid ?? SUBSIDY + 1_000_000), o.empty ? '' : '22'.repeat(32), BITS,
       o.ntime ?? 1_790_000_000 + Math.floor(s * 10)]);
  const block = (hash: string, height: number, arrival: number) => admin.query(
    `INSERT INTO blocks (block_hash, height, block_time, seen_at, coinbase_script_sig, bits, mining_pool)
     VALUES (decode($1, 'hex'), $2, to_timestamp($3::float8), to_timestamp($3::float8), '\\x00', $4, $5::jsonb)`,
    [hash, height, T0 + arrival, BITS, JSON.stringify({ name: `miner-${height}` })]);

  beforeAll(async () => {
    vi.resetModules();
    Object.assign(process.env, {
      PG_HOST: env.PG_TEST_HOST, PG_PORT: env.PG_TEST_PORT ?? '5432', PG_DATABASE: env.PG_TEST_DATABASE ?? 'stratum',
      PG_USER: env.PG_TEST_USER, PG_PASSWORD: env.PG_TEST_PASSWORD, PG_SSLMODE: 'disable',
    });
    admin = new Client({ connectionString: env.PG_TEST_ADMIN_DSN });
    await admin.connect();
    for (const [pool, replica] of [[one, 'a'], [two, 'a'], [two, 'b'], [hidden, 'a']]) {
      const r = await admin.query(
        `INSERT INTO sources (name, site, replica) VALUES ($1, $2, $3)
         ON CONFLICT (name, site, replica) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [pool, SITE, replica]);
      sid[pool === two ? `${pool}/${replica}` : pool] = r.rows[0].id;
    }
    await block(B2, H - 2, -600);
    await block(B1, H - 1, 0);
    await block(B0, H, 120);
    await admin.query(
      `INSERT INTO stale_blocks (block_hash, height, prev_hash, version, block_time, bits, nonce, merkle_root,
                                 chaintip_status, last_status, tip_hash, fork_height, first_seen, mining_pool)
       VALUES (decode($1, 'hex'), $2, decode($3, 'hex'), 1, to_timestamp($4::float8), $5, 1, '\\x00', 'valid-fork',
               'valid-fork', decode($1, 'hex'), $2 - 1, to_timestamp($4::float8), '{"name":"stale-miner"}')`,
      [S1, H - 1, B2, T0 + 1, BITS]);
    await admin.query(`UPDATE blocks SET analysis = $2::jsonb WHERE block_hash = decode($1, 'hex')`, [B0, JSON.stringify({
      flags: [{ key: 'invalid_coinbase_no_merkle', icon: 'error', details: { offenders: [
        { pool_name: one, total_sats: SUBSIDY + 1_000_000, subsidy_sats: SUBSIDY },
        { pool_name: hidden, total_sats: SUBSIDY + 1_000_000, subsidy_sats: SUBSIDY }] } }] })]);

    await insert(one, 1, H, 'o1', B1);
    await insert(one, 2, H, 'o2', B1, { empty: true });                         // invalid work
    await insert(one, 3, H, 'o3', B1, { empty: true });
    await insert(one, 9, H, 'o4', B1);
    await insert(one, 10, H, 'o5', B1, { empty: true, paid: SUBSIDY });         // empty, but pays the subsidy: valid
    await insert(`${two}/a`, 4, H, 't1', S1);
    await insert(`${two}/b`, 4.2, H, 'u1', B1);                                  // the other connection: another parent
    await insert(`${two}/a`, 20, H, 't2', S1);
    await insert(`${two}/b`, 20.5, H, 'u2', B1);
    await insert(`${two}/a`, 60, H, 't3', B1);                                   // the pool moves to B1
    await insert(hidden, 5, H, 'x1', S1);
    await insert(hidden, 8, H, 'x2', S1, { empty: true });
    await insert(one, 125, H + 1, 'n1', B0);                                     // `one` moves on to the next height
    await insert(one, 126, H + 1, 'n2', B0);
  });

  afterAll(async () => {
    await admin?.query(`DELETE FROM templates WHERE source_id = ANY ($1::int[])`, [Object.values(sid)]);
    await admin?.query(`DELETE FROM stale_blocks WHERE block_hash = decode($1, 'hex')`, [S1]);
    await admin?.query(`DELETE FROM blocks WHERE block_hash = ANY (SELECT decode(h, 'hex') FROM unnest($1::text[]) h)`, [[B2, B1, B0]]);
    await admin?.query(`DELETE FROM sources WHERE id = ANY ($1::int[])`, [Object.values(sid)]);
    await admin?.end();
  });

  const read = async (exclude: string[]) => {
    lanes ??= await import('../forkLanes');
    return lanes.getForkLanes(H, { fromMs: (T0 + 1) * 1000, toMs: (T0 + 60) * 1000 }, exclude);
  };
  const lane = (r: Awaited<ReturnType<typeof read>>, pool: string) => r.lanes.find(l => l.pool === pool)!;
  const parentOf = (r: Awaited<ReturnType<typeof read>>, i: number) => r.parents[i].hash;

  it('is one stream per pool: two connections on different parents don\'t make it flap', async () => {
    const r = await read([hidden]);
    expect(lane(r, two).runs.map(([, p]) => parentOf(r, p))).toEqual([S1, B1]);
    expect(lane(r, two).runs.map(([at]) => at)).toEqual([3000, 59_000]);
  });

  it('marks exactly the templates the finding is about as invalid', async () => {
    const r = await read([hidden]);
    expect(lane(r, one).runs).toEqual([[0, r.parents.findIndex(p => p.hash === B1), 0], [1000, r.parents.findIndex(p => p.hash === B1), 1],
      [8000, r.parents.findIndex(p => p.hash === B1), 0]]);
  });

  it('ends a lane when its pool first worked on the next height, else at its own last template', async () => {
    const r = await read([hidden]);
    expect(r.from_ms).toBe((T0 + 1) * 1000);
    expect(lane(r, one).end).toBe(124_000);
    expect(lane(r, two).end).toBe(59_000);
  });

  it('judges the parents and names the blocks; a stale block only the records know has no arrival time', async () => {
    const r = await read([hidden]);
    expect(r.active).toBe(B1);
    expect(Object.fromEntries(r.parents.map(p => [p.hash, p.status]))).toEqual({ [B1]: 'canonical', [S1]: 'stale' });
    const s = r.blocks.find(b => b.hash === S1)!;
    expect(s).toMatchObject({ best: false, stale_only: true, seen_ms: null, miner: 'stale-miner' });
    expect(r.blocks.find(b => b.hash === B1)).toMatchObject({ best: true, seen_ms: T0 * 1000, miner: `miner-${H - 1}` });
  });

  it('gives a block with no recorded arrival the time our feeds first built on it', async () => {
    // the stale block only the records know: its first run, at height - 1
    const r = await read([hidden]);
    const first = Math.min(...r.lanes.flatMap(l => l.runs.filter(x => r.parents[x[1]].hash === S1).map(x => x[0])));
    expect(r.blocks.find(b => b.hash === S1)!.work_ms).toBe(r.from_ms + first);
    expect(r.blocks.find(b => b.hash === B1)!.work_ms).toBeNull();          // arrival recorded
    // the block at the height, its arrival unrecorded: the first next-height template on it
    await admin.query(`UPDATE blocks SET seen_at = NULL WHERE block_hash = decode($1, 'hex')`, [B0]);
    try {
      const u = await read([hidden]);
      const ends = u.lanes.map(l => u.from_ms + l.end);
      expect(u.blocks.find(b => b.hash === B0)!.work_ms).toBe(Math.min(...ends.filter(e => e > u.from_ms + 60_000)));
    } finally {
      await admin.query(`UPDATE blocks SET seen_at = block_time WHERE block_hash = decode($1, 'hex')`, [B0]);
    }
  });

  it('leaves the excluded pool out entirely; without exclusion it is there', async () => {
    const shut = await read([hidden]);
    expect(JSON.stringify(shut)).not.toContain(hidden);
    const open = await read([]);
    expect(lane(open, hidden).runs.map(x => x[2])).toEqual([0, 1]);
  });
});
