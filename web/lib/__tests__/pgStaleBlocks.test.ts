/**
 * getRecentStaleBlocks (lib/db/stale-blocks.ts) against a real, migrated database, as a user in the stratum_web role.
 * Skipped unless a test database is configured, like pgDedupReads.test.ts:
 *
 *   PG_TEST_HOST=… PG_TEST_USER=web PG_TEST_PASSWORD=… PG_TEST_ADMIN_DSN=postgresql://… npm test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

const env = process.env;
const enabled = !!env.PG_TEST_HOST;

// stratum prev_hash for a display-order hash: the eight 4-byte words in reverse order
const toStratum = (hex: string) => (hex.match(/.{8}/g) ?? []).reverse().join('');

describe.skipIf(!enabled)('Postgres stale-block read', () => {
  const h = 3_000_000 + (Math.floor(Date.now() / 1000) % 50_000) * 2;   // unique heights per run; far above any real tip
  const stale = '00000000' + 'a1'.repeat(28);
  const best = '00000000' + 'b1'.repeat(28);
  const parent = '00000000' + 'c1'.repeat(28);
  const next = '00000000' + 'd1'.repeat(28);
  const T0 = 1_794_437_000;
  let mod: typeof import('../db/stale-blocks');
  let admin: Client;

  beforeAll(async () => {
    Object.assign(process.env, {
      PG_HOST: env.PG_TEST_HOST, PG_PORT: env.PG_TEST_PORT ?? '5432', PG_DATABASE: env.PG_TEST_DATABASE ?? 'stratum',
      PG_USER: env.PG_TEST_USER, PG_PASSWORD: env.PG_TEST_PASSWORD, PG_SSLMODE: 'disable',
    });
    mod = await import('../db/stale-blocks');
    admin = new Client({ connectionString: env.PG_TEST_ADMIN_DSN });
    await admin.connect();
    const sid = (await admin.query(
      `INSERT INTO sources (name, site) VALUES ($1, 'ci') ON CONFLICT (name, site, replica) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`, [`wstale-${h}`])).rows[0].id;
    await admin.query(
      `INSERT INTO blocks (block_hash, height, block_time, seen_at, coinbase_script_sig)
       VALUES (decode($1, 'hex'), $2, to_timestamp($3), to_timestamp($3 + 10), '\\x00')`, [best, h, T0]);
    // and the block at h + 1, so height h + 1's receive window ends at our own block: without it, the nearest block
    // above is another suite's (pgForks seeds blocks between this height and its tip that arrived months before T0),
    // and the window would close before these templates
    await admin.query(
      `INSERT INTO blocks (block_hash, height, block_time, seen_at, coinbase_script_sig)
       VALUES (decode($1, 'hex'), $2, to_timestamp($3), to_timestamp($3 + 60), '\\x00')`, [next, h + 1, T0]);
    await admin.query(
      `INSERT INTO stale_blocks (block_hash, height, prev_hash, version, block_time, bits, nonce, merkle_root,
                                 chaintip_status, last_status, tip_hash, fork_height, full_block, mining_pool)
       VALUES (decode($1, 'hex'), $2, decode($3, 'hex'), 536870912, to_timestamp($4), 386000000, 1, '\\x00',
               'valid-fork', 'valid-fork', decode($1, 'hex'), $2 - 1, true, '{"name": "Synthetic"}')`,
      [stale, h, parent, T0 + 1]);
    // a second connection of the same pool with its own jobs (other merkle branches): one exact copy of the first
    // connection's template (counted once) and one job of its own, the pool's last on the stale tip (counted, although
    // the first connection was up the whole time)
    const sidB = (await admin.query(
      `INSERT INTO sources (name, site, replica) VALUES ($1, 'ci', 'b')
       ON CONFLICT (name, site, replica) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [`wstale-${h}`])).rows[0].id;
    for (const [s, prev, src, mb, ntime] of [[2, stale, sid, '', 2], [14, stale, sid, '', 14], [12, best, sid, '', 12],
                                             [3, stale, sidB, '', 2], [16, stale, sidB, 'bb'.repeat(32), 16]] as const) {
      await admin.query(
        `INSERT INTO templates (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2, merkle_branches,
                                version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length)
         VALUES (to_timestamp($1::float8), $2, $3, $4, decode($5, 'hex'), '\\x01', '\\x02', decode($7, 'hex'),
                 536870912, 386000000, $6, true, '\\x03', 8)`, [T0 + s, src, h + 1, `j${s}`, toStratum(prev), ntime, mb]);
    }
  });

  afterAll(async () => {
    await admin?.query(`DELETE FROM stale_blocks WHERE height = $1`, [h]);
    await admin?.query(`DELETE FROM blocks WHERE height = ANY ($1::int[])`, [[h, h + 1]]);
    await admin?.end();
    const { getPgPool } = await import('../db/pg');
    await getPgPool().end();
  });

  it('lists the stale block with the pool that mined on it', async () => {
    const blocks = await mod.getRecentStaleBlocks(100);
    const b = blocks.find(x => x.block_hash === stale);
    expect(b).toBeDefined();
    expect(b!.prev_hash).toBe(parent);
    expect(b!.mining_pool).toEqual({ name: 'Synthetic' });
    expect(b!.templates).toEqual([{ pool: `wstale-${h}`, height: h + 1, templates: 3, first_template_at: (T0 + 2) * 1000,
      last_template_at: (T0 + 16) * 1000, node_switch_at: (T0 + 10) * 1000, mined_after_switch_ms: 6000 }]);
  });
});
