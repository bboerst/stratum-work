/**
 * The Postgres block reads (lib/db/postgres.ts) after a reorg (#194), against a real, migrated database, as a user in
 * the stratum_web role. Reads by height, the lists and the tip skip blocks recorded in stale_blocks as currently
 * stale; a stale block that became active again is shown; the lookup by hash still finds a stale block and flags it.
 * Skipped unless a test database is configured, like pgDedupReads.test.ts:
 *
 *   PG_TEST_HOST=… PG_TEST_USER=web PG_TEST_PASSWORD=… PG_TEST_ADMIN_DSN=postgresql://… npm test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

const env = process.env;
const enabled = !!env.PG_TEST_HOST;

describe.skipIf(!enabled)('Postgres block reads skip stale blocks', () => {
  // h: a reorged-out block (seen first) and its replacement; h + 1: stale once, active again; h + 2: no stale row.
  // top: a reorged-out block above every other test height, with analysis (the tip and R3 must skip it).
  const off = Math.floor(Date.now() / 1000) % 50_000;
  const h = 4_000_000 + off * 4;
  const top = 9_000_000 + off;
  const hash = (k: string) => '00000000' + k.repeat(28);
  const [lost, won, back, plain, topStale, belowTop, sideOnly, nowhere, parseOnly] =
    ['a4', 'b4', 'c4', 'd4', 'e4', 'f4', '1a', '2b', '3c'].map(hash);
  const T0 = 1_794_437_000;
  let pg: typeof import('../db/postgres');
  let admin: Client;

  const block = (bh: string, height: number, seen: number, analysis = '{}') => admin.query(
    `INSERT INTO blocks (block_hash, height, block_time, seen_at, coinbase_script_sig, analysis)
     VALUES (decode($1, 'hex'), $2, to_timestamp($3), to_timestamp($3), '\\x00', $4::jsonb)`, [bh, height, T0 + seen, analysis]);
  const stale = (bh: string, height: number, reorgedIn: boolean) => admin.query(
    `INSERT INTO stale_blocks (block_hash, height, prev_hash, version, block_time, bits, nonce, merkle_root,
                               chaintip_status, last_status, tip_hash, fork_height, was_active, reorged_in_at)
     VALUES (decode($1, 'hex'), $2, '\\x00', 1, to_timestamp($3), 1, 1, '\\x00', 'valid-fork', $4, decode($1, 'hex'),
             $2 - 1, true, CASE WHEN $5 THEN to_timestamp($3 + 60) END)`,
    [bh, height, T0, reorgedIn ? 'active' : 'valid-fork', reorgedIn]);

  beforeAll(async () => {
    Object.assign(process.env, {
      PG_HOST: env.PG_TEST_HOST, PG_PORT: env.PG_TEST_PORT ?? '5432', PG_DATABASE: env.PG_TEST_DATABASE ?? 'stratum',
      PG_USER: env.PG_TEST_USER, PG_PASSWORD: env.PG_TEST_PASSWORD, PG_SSLMODE: 'disable',
    });
    pg = await import('../db/postgres');
    admin = new Client({ connectionString: env.PG_TEST_ADMIN_DSN });   // the web role can't write; insert as admin
    await admin.connect();
    // pgUnknownParents.test.ts seeds the next-highest chain and checks it is the tip: one of the two at a time
    await admin.query('SELECT pg_advisory_lock($1)', [72_010_261]);   // released when admin disconnects (afterAll)
    const flagged = '{"flags": [{"type": "synthetic"}]}';
    await block(lost, h, 0);            // seen first: the old reads returned it
    await block(won, h, 100);
    await block(back, h + 1, 200);
    await block(plain, h + 2, 300);
    await block(belowTop, top - 1, 400, flagged);
    await block(parseOnly, top - 2, 450, '{"coinbase_parse": {"repaired": [], "unparsed": []}}');   // a diagnostic, not a finding
    await block(topStale, top, 500, flagged);
    await stale(lost, h, false);
    await stale(back, h + 1, true);
    await stale(topStale, top, false);
    await stale(sideOnly, h, false);    // a side block known only from the stale tracker (headers only)
  }, 120_000);                                   // may wait for the other suite's tip lock

  afterAll(async () => {
    await admin?.query(`DELETE FROM stale_blocks WHERE height = ANY($1::int[])`, [[h, h + 1, top]]);
    await admin?.query(`DELETE FROM blocks WHERE height = ANY($1::int[])`, [[h, h + 1, h + 2, top - 2, top - 1, top]]);
    await admin?.end();
    const { getPgPool } = await import('../db/pg');
    await getPgPool().end();
  });

  it('R6 by height: the replacement, not the reorged-out block seen first', async () => {
    expect((await pg.getBlockByHeight(h))?.block_hash).toBe(won);
    expect((await pg.getBlockByHeight(h + 1))?.block_hash).toBe(back);    // stale, then active again: shown
    expect((await pg.getBlockByHeight(h + 2))?.block_hash).toBe(plain);   // no stale row: unchanged
    expect(await pg.getBlockByHeight(top)).toBeNull();                    // only a stale block there
  });

  it('R6 by hash: a stale block is still found, flagged stale; others carry no flag', async () => {
    const s = await pg.getBlockByHash(lost);
    expect(s?.height).toBe(h);
    expect(s?.stale).toBe(true);
    for (const bh of [won, back, plain]) {
      const b = await pg.getBlockByHash(bh);
      expect(b?.block_hash).toBe(bh);
      expect(b).not.toHaveProperty('stale');
    }
  });

  it('R5: one block per height in all three modes', async () => {
    const around = await pg.getBlocks(4, undefined, h + 1);
    expect(around.blocks.filter(b => b.height >= h && b.height <= h + 2).map(b => b.block_hash)).toEqual([plain, back, won]);
    const before = await pg.getBlocks(3, h + 2);
    expect(before.blocks.map(b => b.block_hash)).toEqual([plain, back, won]);
    const after = await pg.getBlocks(3, undefined, undefined, h - 1);
    expect(after.blocks.map(b => b.block_hash)).toEqual([plain, back, won]);
    const latest = await pg.getBlocks(5);
    expect(latest.blocks.map(b => b.block_hash)).not.toContain(topStale);
  });

  it('R5: stale siblings at a block\'s height, in the order they were seen; none elsewhere', async () => {
    const page = await pg.getBlocks(3, h + 2);
    const at = (height: number) => page.blocks.find(b => b.height === height);
    expect(at(h)?.stale_siblings?.map(s => s.block_hash).sort()).toEqual([lost, sideOnly].sort());
    expect(at(h)?.stale_siblings?.every(s => s.pool === null)).toBe(true);
    expect(at(h + 1)?.stale_siblings).toBeUndefined();   // stale once, active again: not a sibling
    expect(at(h + 2)?.stale_siblings).toBeUndefined();
    const around = await pg.getBlocks(4, undefined, h + 1);
    expect(around.blocks.find(b => b.height === h)?.stale_siblings).toHaveLength(2);
  });

  it('fork visual (#212): known block hashes are blocks and currently stale side blocks', async () => {
    const known = await pg.knownBlockHashes([lost, won, sideOnly, nowhere, won.toUpperCase(), 'not-hex']);
    expect([...known].sort()).toEqual([lost, sideOnly, won].sort());
    expect((await pg.knownBlockHashes([])).size).toBe(0);
  });

  it('tip and R3: a reorged-out block above the new tip is neither the tip nor listed', async () => {
    const tip = await pg.getHighestBlock();
    expect(tip?.block_hash).toBe(belowTop);
    const interesting = (await pg.getInterestingBlocks()).map(b => b.block_hash);
    expect(interesting).toContain(belowTop);
    expect(interesting).not.toContain(topStale);
    expect(interesting).not.toContain(parseOnly);
  });
});
