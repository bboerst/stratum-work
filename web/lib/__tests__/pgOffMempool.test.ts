/**
 * The off-mempool reads (lib/db/off-mempool.ts, #328) against a real, migrated database, as a user in the stratum_web
 * role: the recorder's internal-order hashes joined to blocks' display-order ones, a reorged-out block left out, a
 * resync found from the rows it closed, and one block's positions. Synthetic hashes and heights. Holds the tip lock
 * like pgBlocksBest (its blocks may be the highest while it runs). Skipped unless a test database is configured:
 *
 *   PG_TEST_HOST=… PG_TEST_USER=web PG_TEST_PASSWORD=… PG_TEST_ADMIN_DSN=postgresql://… npm test
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { OFF_STATE, assembleOffMempool } from '../offMempool';

const env = process.env;
const enabled = !!env.PG_TEST_HOST;

describe.skipIf(!enabled)('Postgres off-mempool reads', () => {
  const off = Math.floor(Date.now() / 1000) % 50_000;
  const h = 5_000_000 + off * 8;
  const T0 = Math.floor(Date.now() / 1000) - 3600;
  const hex = () => randomBytes(32).toString('hex');            // display order
  const internal = (d: string) => Buffer.from(d, 'hex').reverse();
  const best = Array.from({ length: 4 }, hex);                    // heights h .. h+3
  const lost = hex();                                             // reorged out at h+1
  let db: typeof import('../db/off-mempool');
  let admin: Client;

  beforeAll(async () => {
    Object.assign(process.env, {
      PG_HOST: env.PG_TEST_HOST, PG_PORT: env.PG_TEST_PORT ?? '5432', PG_DATABASE: env.PG_TEST_DATABASE ?? 'stratum',
      PG_USER: env.PG_TEST_USER, PG_PASSWORD: env.PG_TEST_PASSWORD, PG_SSLMODE: 'disable',
    });
    db = await import('../db/off-mempool');
    admin = new Client({ connectionString: env.PG_TEST_ADMIN_DSN });
    await admin.connect();
    await admin.query('SELECT pg_advisory_lock($1)', [72_010_261]);
    const block = (bh: string, height: number, at: number) => admin.query(
      `INSERT INTO blocks (block_hash, height, block_time, seen_at, coinbase_script_sig, mining_pool)
       VALUES (decode($1, 'hex'), $2, to_timestamp($3), to_timestamp($3), '\\x00', '{"name": "SynthPool"}')`, [bh, height, at]);
    const rec = (bh: string, height: number, at: number, o: { tx: number; offc: number | null; checked: boolean }) => admin.query(
      `INSERT INTO mempool_blocks (seen_at, block_hash, height, event, tx_count, from_mempool, off_mempool, off_mempool_checked)
       VALUES (to_timestamp($1), $2, $3, 'connect', $4, $4 - 1 - coalesce($5, 0), $5, $6)`,
      [at, internal(bh), height, o.tx, o.offc, o.checked]);
    for (let i = 0; i < 4; i++) await block(best[i], h + i, T0 + i * 600);
    await block(lost, h + 1, T0 + 590);
    await admin.query(
      `INSERT INTO stale_blocks (block_hash, height, prev_hash, version, block_time, bits, nonce, merkle_root,
                                 chaintip_status, last_status, tip_hash, fork_height, was_active)
       VALUES (decode($1, 'hex'), $2, '\\x00', 1, to_timestamp($3), 1, 1, '\\x00', 'valid-fork', 'valid-fork', decode($1, 'hex'), $2 - 1, true)`,
      [lost, h + 1, T0 + 590]);
    await rec(best[0], h, T0, { tx: 11, offc: 3, checked: true });
    await rec(lost, h + 1, T0 + 591, { tx: 50, offc: 49, checked: true });
    await rec(best[1], h + 1, T0 + 601, { tx: 11, offc: 0, checked: true });
    await rec(best[1], h + 1, T0 + 900, { tx: 11, offc: 7, checked: true });   // a reconnect later: the first counts
    await rec(best[2], h + 2, T0 + 1200, { tx: 11, offc: null, checked: false });
    // h+3: not recorded
    for (const pos of [1, 2, 5]) {
      await admin.query(`INSERT INTO mempool_offmempool (block_hash, height, seen_at, txid, position) VALUES ($1, $2, to_timestamp($3), $4, $5)`,
        [internal(best[0]), h, T0, randomBytes(32), pos]);
    }
    // a resync at T0 + 1000 closed a row
    await admin.query(`INSERT INTO mempool_txs (first_seen, first_seen_src, txid, removed_at, removal, removed_src)
      VALUES (to_timestamp($1), 'zmq', $2, to_timestamp($3), 'unknown', 'resync')`, [T0 - 100, randomBytes(32), T0 + 1000]);
  }, 120_000);

  afterAll(async () => {
    await admin?.query(`DELETE FROM mempool_offmempool WHERE height BETWEEN $1 AND $2`, [h, h + 3]);
    await admin?.query(`DELETE FROM mempool_blocks WHERE height BETWEEN $1 AND $2`, [h, h + 3]);
    await admin?.query(`DELETE FROM mempool_txs WHERE removed_src = 'resync' AND removed_at = to_timestamp($1)`, [T0 + 1000]);
    await admin?.query(`DELETE FROM stale_blocks WHERE height BETWEEN $1 AND $2`, [h, h + 3]);
    await admin?.query(`DELETE FROM blocks WHERE height BETWEEN $1 AND $2`, [h, h + 3]);
    await admin?.end();
    const { getPgPool } = await import('../db/pg');
    await getPgPool().end();
  });

  it('best-chain blocks only, with their miner', async () => {
    const chain = await db.getChainBlocks(h, h + 3);
    expect(chain.map(b => b.hash)).toEqual(best);
    expect(chain[0]).toMatchObject({ height: h, pool: 'SynthPool', time_s: T0 });
  });

  it("recorder rows keyed by blocks' display-order hash, the first connect of each", async () => {
    const rec = await db.getRecordedBlocks(h, h + 3);
    expect(rec.get(best[0])).toMatchObject({ tx_count: 11, off_mempool: 3, checked: true, seen_ms: T0 * 1000 });
    expect(rec.get(best[1])?.off_mempool).toBe(0);
    expect(rec.get(best[2])).toMatchObject({ off_mempool: null, checked: false });
    expect(rec.has(best[3])).toBe(false);
    expect(rec.has(lost)).toBe(true);      // read, but assembly keys off the best chain
  });

  it('resync times since a bound, and positions by height', async () => {
    expect(await db.getResyncTimes(T0 * 1000)).toContain((T0 + 1000) * 1000);
    expect(await db.getResyncTimes((T0 + 1001) * 1000)).not.toContain((T0 + 1000) * 1000);
    expect(await db.getOffPositions(h)).toEqual([1, 2, 5]);
    expect(await db.getOffPositions(h + 1)).toEqual([]);
    expect(await db.getRecordFrom()).not.toBeNull();
  });

  it('end to end: no row reads as a measured zero unless it is one', async () => {
    const [chain, rec, syncs] = await Promise.all([db.getChainBlocks(h, h + 3), db.getRecordedBlocks(h, h + 3), db.getResyncTimes(T0 * 1000)]);
    const rows = assembleOffMempool(chain, rec, syncs, h, h);
    expect(rows.map(r => [r[0] - h, r[3], r[4]])).toEqual([
      [0, 3, OFF_STATE.afterGap], [1, 0, OFF_STATE.afterGap], [2, null, OFF_STATE.unchecked], [3, null, OFF_STATE.missed],
    ]);
  });
});
