/**
 * /api/other-chains (app/api/other-chains/route.ts, lib/db/other-chains.ts) against a real, migrated database, as a
 * user in the stratum_web role: the summary aggregation (counts, heights, prev hashes, months, AuxPoW share), one
 * stream per pool for a pool with two collectors, keyset pagination (including rows sharing a receive time),
 * POOL_BLACKLIST exclusion at every height, and extranonce1 masking. Skipped unless a test database is configured,
 * like pgDedupReads.test.ts:
 *
 *   PG_TEST_HOST=… PG_TEST_USER=web PG_TEST_PASSWORD=… PG_TEST_ADMIN_DSN=postgresql://… npm test
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { createMasker } from '../connectionMask';

const env = process.env;
const enabled = !!env.PG_TEST_HOST;
const KEY = 'pg-other-chains-test-key';

describe.skipIf(!enabled)('Postgres other-chain templates', () => {
  const run = Math.floor(Date.now() / 1000) % 1_000_000;
  const single = `wother-${run}`;          // one collector
  const multi = `wotherm-${run}`;          // two collectors (replicas a, b)
  const hidden = `wotherx-${run}`;         // blacklisted
  const T0 = Date.UTC(2026, 9, 10) / 1000; // 2026-10-10: months 2026-10 .. 2026-12
  const DAY = 86_400;
  const EN1 = { [single]: 'c0ffee01', [multi]: 'c0ffee02', [hidden]: 'c0ffee03' } as Record<string, string>;
  // a minimal coinbase: version 1, one input with a 4-byte height push, split around the extranonce
  // (scriptSig: the height push, optional AuxPoW commitment, 4 + 4 extranonce bytes)
  const AUX = 'fabe6d6d' + 'ab'.repeat(32) + '0100000000000000';
  const cb1 = (scriptSigBytes: number) => '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff'
    + scriptSigBytes.toString(16).padStart(2, '0') + '0340420f';
  const CB1 = cb1(12);
  const CB2 = 'ffffffff0100f2052a01000000016a00000000';
  let route: typeof import('../../app/api/other-chains/route');
  let admin: Client;
  const sid: Record<string, number> = {};

  const insert = (src: string, s: number, height: number, job: string, o: {
    prev?: string; cb1?: string; cb2?: string; chain?: string; reason?: string; ntime?: number; en1?: string } = {}) =>
    admin.query(
      `INSERT INTO templates_other (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2,
                                    merkle_branches, version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length,
                                    chain, reason)
       VALUES (to_timestamp($1::float8), $2, $3, $4, decode(repeat($5, 32), 'hex'), decode($6, 'hex'), decode($7, 'hex'),
               decode(repeat('11', 32), 'hex'), 536870912, 386000000, $8, true, decode($9, 'hex'), 4, $10::chain, $11)`,
      [T0 + s, sid[src], height, job, o.prev ?? 'aa', o.cb1 ?? CB1, o.cb2 ?? CB2, o.ntime ?? 1_790_000_000 + Math.floor(s),
       o.en1 ?? EN1[src.split('/')[0]], o.chain ?? 'unknown', o.reason ?? 'height_implausible']);

  const get = async (qs = '') => {
    const res = await route.GET(new Request(`http://localhost/api/other-chains${qs}`));
    return { status: res.status, text: await res.clone().text(), body: await res.json() };
  };

  beforeAll(async () => {
    vi.resetModules();
    Object.assign(process.env, {
      PG_HOST: env.PG_TEST_HOST, PG_PORT: env.PG_TEST_PORT ?? '5432', PG_DATABASE: env.PG_TEST_DATABASE ?? 'stratum',
      PG_USER: env.PG_TEST_USER, PG_PASSWORD: env.PG_TEST_PASSWORD, PG_SSLMODE: 'disable',
      DB_BACKEND: 'postgres', POOL_BLACKLIST: hidden, EXTRANONCE1_MASK_KEY: KEY,
    });
    admin = new Client({ connectionString: env.PG_TEST_ADMIN_DSN });   // the web role can't write; insert as admin
    await admin.connect();
    for (const [pool, replica] of [[single, 'a'], [multi, 'a'], [multi, 'b'], [hidden, 'a']]) {
      const r = await admin.query(
        `INSERT INTO sources (name, site, replica) VALUES ($1, 'ci', $2)
         ON CONFLICT (name, site, replica) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [pool, replica]);
      sid[pool === multi ? `${pool}/${replica}` : pool] = r.rows[0].id;
    }
    // single: 5 'unknown' rows over two heights and two prev hashes (two with AuxPoW: one in coinbase1, one in
    // coinbase2), two of them at the same receive time; one 'bch' row in December
    await insert(single, 0, 5_000_000, 'u1');
    await insert(single, 10, 5_000_000, 'u2', { cb1: cb1(56) + AUX });
    await insert(single, 20, 5_000_001, 'u3', { prev: 'bb', cb1: cb1(56), cb2: AUX + CB2 });
    await insert(single, 20, 5_000_001, 'u4', { prev: 'bb' });
    await insert(single, 30, 5_000_001, 'u5', { prev: 'bb' });
    await insert(single, 60 * DAY, 940_000, 'b1', { chain: 'bch', reason: 'bch' });
    // multi: replica a's two templates, b's exact copy of the first (hidden: counted once, 2 connections)
    await insert(`${multi}/a`, 100, 7_000_000, 'm1', { ntime: 1_790_000_100 });
    await insert(`${multi}/b`, 100.5, 7_000_000, 'n1', { ntime: 1_790_000_100, en1: 'c0ffee04' });
    await insert(`${multi}/a`, 130, 7_000_000, 'm2', { ntime: 1_790_000_130 });
    // blacklisted: an old height (history elsewhere, but this view hides the pool entirely)
    await insert(hidden, 5, 14_000, 'x1');
    route = await import('../../app/api/other-chains/route');
  });

  afterAll(async () => {
    await admin?.end();
    const { getPgPool } = await import('../db/pg');
    await getPgPool().end();
  });

  it('summarizes per pool, chain and reason', async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.supported).toBe(true);
    const mine = body.groups.filter((g: { pool: string }) => [single, multi, hidden].includes(g.pool));
    expect(mine.map((g: { pool: string; chain: string }) => `${g.pool}/${g.chain}`).sort())
      .toEqual([`${multi}/unknown`, `${single}/bch`, `${single}/unknown`].sort());
    const u = mine.find((g: { pool: string; chain: string }) => g.pool === single && g.chain === 'unknown');
    expect(u).toMatchObject({
      reason: 'height_implausible', templates: 5, min_height: 5_000_000, max_height: 5_000_001, distinct_heights: 2,
      distinct_prev_hashes: 2, first_seen: T0 * 1000, last_seen: (T0 + 30) * 1000, auxpow_templates: 2, auxpow_share: 0.4,
    });
    const months: string[] = body.months;
    expect(months).toEqual(expect.arrayContaining(['2026-10', '2026-11', '2026-12']));
    const at = (g: { monthly: number[] }, m: string) => g.monthly[months.indexOf(m)];
    expect(at(u, '2026-10')).toBe(5);
    expect(at(u, '2026-12')).toBe(0);
    const b = mine.find((g: { chain: string }) => g.chain === 'bch');
    expect([at(b, '2026-10'), at(b, '2026-11'), at(b, '2026-12')]).toEqual([0, 0, 1]);
    const m = mine.find((g: { pool: string }) => g.pool === multi);
    expect(m).toMatchObject({ templates: 2, distinct_heights: 1, auxpow_templates: 0 });
  });

  it('pages newest first, keeping rows that share a receive time together', async () => {
    const q = `?pool=${single}&chain=unknown&reason=height_implausible&n=2`;
    const p1 = (await get(q)).body;
    expect(p1.templates.map((t: { id: string }) => t.id.split('-').pop())).toEqual(['u5', 'u4', 'u3']);
    expect(p1.next_before).toBe(String((T0 + 20) * 1_000_000));
    const p2 = (await get(`${q}&before=${p1.next_before}`)).body;
    expect(p2.templates.map((t: { id: string }) => t.id.split('-').pop())).toEqual(['u2', 'u1']);
    expect(p2.next_before).toBeNull();
    const t = p1.templates.find((x: { id: string }) => x.id.endsWith('-u3'));
    expect(t).toMatchObject({ height: 5_000_001, chain: 'unknown', auxpow: true, scriptsig_height: 1_000_000,
      prev_hash: 'bb'.repeat(32), copies: 1, coinbase_ok: true });
    expect(p2.templates.find((x: { id: string }) => x.id.endsWith('-u2'))).toMatchObject({ auxpow: true,
      auxpow_root: 'ab'.repeat(32), auxpow_merkle_size: 1 });
    expect(p2.templates.find((x: { id: string }) => x.id.endsWith('-u1')).auxpow).toBe(false);
    // the whole group without filters, and a chain filter
    expect((await get(`?pool=${single}`)).body.templates).toHaveLength(6);
    expect((await get(`?pool=${single}&chain=bch`)).body.templates.map((x: { height: number }) => x.height)).toEqual([940_000]);
  });

  it('reads one stream per pool with several collectors, and pages it', async () => {
    const all = (await get(`?pool=${multi}`)).body.templates;
    expect(all.map((t: { id: string; copies: number }) => [t.id.split('-').pop(), t.copies])).toEqual([['m2', 1], ['m1', 2]]);
    const p1 = (await get(`?pool=${multi}&n=1`)).body;
    expect(p1.templates.map((t: { id: string }) => t.id.split('-').pop())).toEqual(['m2']);
    const p2 = (await get(`?pool=${multi}&n=1&before=${p1.next_before}`)).body;
    expect(p2.templates.map((t: { id: string }) => t.id.split('-').pop())).toEqual(['m1']);
    expect(p2.next_before).toBeNull();
  });

  it('leaves blacklisted pools out entirely', async () => {
    const { body, text } = await get(`?pool=${hidden}`);
    expect(body.templates).toEqual([]);
    expect(body.next_before).toBeNull();
    expect(text).not.toContain(EN1[hidden]);
    expect((await get()).text).not.toContain(hidden);
  });

  it('masks extranonce1', async () => {
    const mask = createMasker(KEY);
    for (const pool of [single, multi]) {
      const { body, text } = await get(`?pool=${pool}`);
      for (const raw of Object.values(EN1).concat('c0ffee04')) expect(text).not.toContain(raw);
      for (const t of body.templates) expect(t.extranonce1).toBe(mask(pool, EN1[pool]));
    }
  });
});
