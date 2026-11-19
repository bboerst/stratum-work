/**
 * getTxs (lib/db/tx.ts, #198) against a real, migrated database, as a user in the stratum_web role, and the query
 * plan. Skipped unless a test database is configured, like pgStaleBlocks.test.ts:
 *
 *   PG_TEST_HOST=… PG_TEST_USER=web PG_TEST_PASSWORD=… PG_TEST_ADMIN_DSN=postgresql://… npm test
 *
 * Synthetic transactions with random txids (no real data).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import type { TxInfo } from '../db/tx';

const env = process.env;
const enabled = !!env.PG_TEST_HOST;

const txid = () => randomBytes(32).toString('hex');   // display order
const internal = (display: string) => Buffer.from(display, 'hex').reverse();

describe.skipIf(!enabled)('Postgres transaction read', () => {
  const tx = {
    inMempool: txid(), mined: txid(), replaced: txid(), offOnly: txid(), notSeen: txid(), child: txid(),
    evictedThenOff: txid(), noFee: txid(), oldCompressed: txid(), cpfpParent: txid(), cpfpChild: txid(),
    lateChild: txid(), cheapChild: txid(),
  };
  const block = txid();
  const block2 = txid();
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);
  let mod: typeof import('../db/tx');
  let lookup: typeof import('../txLookup');
  let admin: Client;

  async function insertTx(t: string, firstSeen: Date, o: Record<string, unknown> = {}) {
    const row = {
      first_seen_src: 'zmq', size: 222, vsize: 141, weight: 561, fee: 2820, modified_fee: 2820, ancestor_count: 1,
      ancestor_size: 141, ancestor_fees: 2820, descendant_count: 1, descendant_size: 141, descendant_fees: 2820,
      removed_at: null, removal: null, removed_src: null, replaced_by: null, block_hash: null, block_height: null, ...o,
    };
    const cols = Object.keys(row);
    await admin.query(
      `INSERT INTO mempool_txs (first_seen, txid, ${cols.join(', ')}) VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')})`,
      [firstSeen, internal(t), ...Object.values(row)]);
  }

  beforeAll(async () => {
    Object.assign(process.env, {
      PG_HOST: env.PG_TEST_HOST, PG_PORT: env.PG_TEST_PORT ?? '5432', PG_DATABASE: env.PG_TEST_DATABASE ?? 'stratum',
      PG_USER: env.PG_TEST_USER, PG_PASSWORD: env.PG_TEST_PASSWORD, PG_SSLMODE: 'disable',
    });
    mod = await import('../db/tx');
    lookup = await import('../txLookup');
    admin = new Client({ connectionString: env.PG_TEST_ADMIN_DSN });
    await admin.connect();

    await insertTx(tx.inMempool, at(5));
    await insertTx(tx.mined, at(600), { removed_at: at(500), removal: 'evicted', removed_src: 'zmq' });   // an earlier stay
    await insertTx(tx.mined, at(30), { fee: 1410, removed_at: at(2), removal: 'mined', removed_src: 'zmq',
      block_hash: internal(block), block_height: 3_000_001 });
    await insertTx(tx.replaced, at(40), { removed_at: at(20), removal: 'replaced', removed_src: 'zmq',
      replaced_by: internal(tx.inMempool) });
    // a child of a low-fee parent: 5000 sat / 100 vB alone, 5200 / 300 with its ancestor
    await insertTx(tx.child, at(3), { vsize: 100, weight: 400, fee: 5000, modified_fee: 5000, ancestor_count: 2,
      ancestor_size: 300, ancestor_fees: 5200 });
    // CPFP: a 1 sat/vB parent, a child seen 10 min later whose package with it pays ~199 sat/vB, a cheaper child, and
    // a child first seen after the template time used below
    // parent and the ~199 sat/vB child were mined together in `block`; the late child wasn't
    const minedIn = { removed_at: at(1), removal: 'mined', removed_src: 'zmq', block_hash: internal(block), block_height: 3_000_001 };
    await insertTx(tx.cpfpParent, at(60), { size: 372, vsize: 209, weight: 834, fee: 209, modified_fee: 209,
      ancestor_size: 209, ancestor_fees: 209, descendant_size: 209, descendant_fees: 209, ...minedIn });
    await insertTx(tx.cpfpChild, at(50), { vsize: 93, weight: 373, fee: 60027, modified_fee: 60027, ancestor_count: 2,
      ancestor_size: 302, ancestor_fees: 60236, ...minedIn });
    await insertTx(tx.cheapChild, at(45), { vsize: 100, fee: 100, modified_fee: 100, ancestor_count: 2,
      ancestor_size: 309, ancestor_fees: 309 });
    await insertTx(tx.lateChild, at(10), { vsize: 100, fee: 100_000, modified_fee: 100_000, ancestor_count: 2,
      ancestor_size: 309, ancestor_fees: 100_209 });
    for (const [c, seen] of [[tx.cpfpChild, at(50)], [tx.cheapChild, at(45)], [tx.lateChild, at(10)]] as const) {
      await admin.query(`INSERT INTO mempool_tx_inputs (first_seen, txid, n, prevout_txid, prevout_vout)
                         VALUES ($1, $2, 0, $3, 0), ($1, $2, 1, $4, 1)`,
        [seen, internal(c), internal(tx.cpfpParent), randomBytes(32)]);
    }
    await insertTx(tx.noFee, at(3), { fee: null, modified_fee: null, ancestor_count: null, ancestor_size: null,
      ancestor_fees: null, descendant_count: null, descendant_size: null, descendant_fees: null,
      removed_at: at(3), removal: 'unknown', removed_src: 'resync' });
    await insertTx(tx.evictedThenOff, at(300), { removed_at: at(200), removal: 'evicted', removed_src: 'zmq' });
    // an old stay in a compressed chunk (the bloom-filter path)
    await insertTx(tx.oldCompressed, new Date(now - 20 * 86_400_000), { removed_at: new Date(now - 19 * 86_400_000),
      removal: 'mined', removed_src: 'zmq', block_hash: internal(block2), block_height: 2_999_000 });
    await admin.query(`SELECT compress_chunk(c, if_not_compressed => true)
                         FROM show_chunks('mempool_txs', older_than => now() - interval '16 days') c`);
    for (const [t, b, pos] of [[tx.offOnly, block, 1], [tx.evictedThenOff, block, 2]] as const) {
      await admin.query(
        `INSERT INTO mempool_offmempool (block_hash, height, seen_at, txid, position) VALUES ($1, 3000001, $2, $3, $4)`,
        [internal(b), at(2), internal(t), pos]);
    }
  });

  afterAll(async () => {
    const all = Object.values(tx).map(internal);
    await admin?.query(`DELETE FROM mempool_tx_inputs WHERE txid = ANY($1)`, [all]);
    await admin?.query(`DELETE FROM mempool_offmempool WHERE txid = ANY($1)`, [all]);
    await admin?.query(`DELETE FROM mempool_txs WHERE txid = ANY($1)`, [all]);
    await admin?.end();
    const { getPgPool } = await import('../db/pg');
    await getPgPool().end();
  });

  const byStatus = (txs: TxInfo[]) => Object.fromEntries(txs.map(t => [t.txid, t]));

  it('classifies every case in one batch, in request order', async () => {
    const order = [tx.notSeen, tx.inMempool, tx.mined, tx.replaced, tx.offOnly, tx.child, tx.evictedThenOff, tx.noFee];
    const txs = await mod.getTxs(order);
    expect(txs.map(t => t.txid)).toEqual(order);
    const r = byStatus(txs);

    expect(r[tx.notSeen]).toEqual({ txid: tx.notSeen, found: false, status: 'not_seen' });

    expect(r[tx.inMempool]).toMatchObject({ found: true, status: 'in_mempool', fee: 2820, vsize: 141, weight: 561,
      fee_rate: 20, ancestor_fee_rate: 20, effective_fee_rate: 20, ancestor_count: 1, descendant_count: 1,
      first_seen: at(5).getTime(), first_seen_src: 'zmq', removal: null, offmempool: null });

    expect(r[tx.mined]).toMatchObject({ status: 'mined', fee: 1410, fee_rate: 10,
      first_seen: at(30).getTime(),
      removal: { at: at(2).getTime(), reason: 'mined', source: 'zmq', replaced_by: null, block_hash: block,
        block_height: 3_000_001 } });

    expect(r[tx.replaced]).toMatchObject({ status: 'replaced', removal: { reason: 'replaced', replaced_by: tx.inMempool } });

    expect(r[tx.offOnly]).toMatchObject({ found: true, status: 'off_mempool', fee: null, fee_rate: null,
      effective_fee_rate: null, removal: null,
      offmempool: { block_hash: block, height: 3_000_001, seen_at: at(2).getTime(), position: 1 } });

    expect(r[tx.child].fee_rate).toBe(50);
    expect(r[tx.child].ancestor_fee_rate).toBeCloseTo(5200 / 300, 10);
    expect(r[tx.child].effective_fee_rate).toBeCloseTo(5200 / 300, 10);

    // left our mempool, mined later without being in it
    expect(r[tx.evictedThenOff]).toMatchObject({ status: 'off_mempool', removal: { reason: 'evicted' },
      offmempool: { position: 2 } });

    expect(r[tx.noFee]).toMatchObject({ status: 'unknown', fee: null, effective_fee_rate: null,
      removal: { source: 'resync' } });

  });

  it('raises a parent to its paying child\'s package rate, children seen by `at` only (CPFP)', async () => {
    const [now_] = await mod.getTxs([tx.cpfpParent]);
    expect(now_.fee_rate).toBe(1);
    // by now the best package is the late child's, which wasn't mined with the parent
    expect(now_.child).toEqual({ txid: tx.lateChild, first_seen: at(10).getTime(), package_fee_rate: 100_209 / 309,
      block_hash: null, same_block: false });
    // the late child (100,209 / 309) is the best package by now
    expect(now_.child_package_fee_rate).toBeCloseTo(100_209 / 309, 10);
    expect(now_.effective_fee_rate).toBeCloseTo(100_209 / 309, 10);
    // as of a template received 30 min ago: the late child wasn't seen yet, the cheap one doesn't count
    const [then] = await mod.getTxs([tx.cpfpParent], at(30).getTime());
    expect(then.child_package_fee_rate).toBeCloseTo(60_236 / 302, 10);
    expect(then.effective_fee_rate).toBeCloseTo(199.46, 2);
    expect(then.child).toEqual({ txid: tx.cpfpChild, first_seen: at(50).getTime(), package_fee_rate: 60_236 / 302,
      block_hash: block, same_block: true });
    // before any child: its own rate
    const [first] = await mod.getTxs([tx.cpfpParent], at(55).getTime());
    expect(first).toMatchObject({ child_package_fee_rate: null, child: null, effective_fee_rate: 1 });
    // a transaction without children
    expect((await mod.getTxs([tx.inMempool]))[0]).toMatchObject({ child_package_fee_rate: null, child: null, effective_fee_rate: 20 });
  });

  it('searches stays first seen within 15 days before `at` (compressed chunks too)', async () => {
    const twentyDaysAgo = now - 20 * 86_400_000;
    expect((await mod.getTxs([tx.oldCompressed]))[0]).toMatchObject({ found: false, status: 'not_seen' });
    expect((await mod.getTxs([tx.oldCompressed, tx.inMempool], twentyDaysAgo + 3_600_000))).toMatchObject([
      { status: 'mined', removal: { block_hash: block2, block_height: 2_999_000 } },
      { status: 'not_seen' },   // first seen after the window
    ]);
  });

  it('serves the routes from the database', async () => {
    lookup.clearTxCache();
    const route = await import('../../app/api/tx/route');
    const resp = await route.GET(new Request(`http://localhost/api/tx?txids=${tx.mined},${tx.inMempool.toUpperCase()}`));
    expect(resp.status).toBe(200);
    expect(resp.headers.get('Cache-Control')).toBe('public, max-age=30');
    const body = await resp.json();
    expect(body.txs.map((t: TxInfo) => t.status)).toEqual(['mined', 'in_mempool']);
  });

  it('uses the txid indexes, and bloom filters on compressed chunks', async () => {
    const planNodes = async (atMs: number) => {
      const plan = (await admin.query(`EXPLAIN (FORMAT JSON) ${mod.TX_SQL}`, [[tx.mined, tx.offOnly],
        new Date(atMs - mod.TX_WINDOW_BEFORE_MS), new Date(atMs + mod.TX_WINDOW_AFTER_MS), new Date(atMs)])).rows[0]['QUERY PLAN'];
      const nodes: { type: string; rel?: string; index?: string; filter?: string }[] = [];
      const walk = (n: Record<string, unknown>) => {
        nodes.push({ type: n['Node Type'] as string, rel: n['Relation Name'] as string, index: n['Index Name'] as string,
          filter: n.Filter as string | undefined });
        for (const c of (n.Plans as Record<string, unknown>[] | undefined) ?? []) walk(c);
      };
      walk(plan[0].Plan);
      return nodes;
    };
    const recent = await planNodes(now);                       // uncompressed chunks: the btree index
    expect(recent.some(n => n.index?.endsWith('mempool_txs_txid'))).toBe(true);
    expect(recent.some(n => n.index === 'mempool_offmempool_txid')).toBe(true);
    const old = await planNodes(now - 20 * 86_400_000);        // reaches the compressed chunk: bloom filters
    expect(old.some(n => n.rel?.endsWith('_compressed'))).toBe(true);
    for (const nodes of [recent, old]) {
      // The only scans are of compressed chunks' batch rows, filtered by the txid bloom filter
      const scans = nodes.filter(n => n.type === 'Seq Scan');
      expect(scans.filter(n => !n.rel?.endsWith('_compressed'))).toEqual([]);
      for (const n of scans) expect(n.filter).toContain('bloom1_contains');
    }
  });
});
