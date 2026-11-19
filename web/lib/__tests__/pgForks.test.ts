/**
 * /api/forks (app/api/forks/route.ts, alias /api/unknown-parents; lib/unknownParents.ts, lib/db/unknown-parents.ts)
 * against a real, migrated database, as a user in the stratum_web role. Seeds a short Bitcoin chain and episodes of
 * each kind, plus a blacklisted pool on a shared parent and on a parent of its own:
 *  A  bitcoin_block   a competitor of our best block at H - 1, meeting its target, built on by two pools (one on two
 *                     connections, an exact copy counted once) and the blacklisted pool
 *  B  invalid_parent  an (almost) all-ff hash at H + 1 with Bitcoin's nbits
 *  C  other_chain     a parent at a height far below our tip, with other nbits
 *  D  other_chain     a parent whose last template arrived between our blocks at tip - 52,416 and tip - 12,096: in
 *                     26 epochs and all history, not in 6 epochs
 *  F  other_chain     a parent whose last template arrived before our block at tip - 52,416: in all history only
 *  E  a parent recorded as a block after the summary was written: gone at read time, its row untouched
 *  S1 stale           a recorded stale block at H - 1 (miner identified), built on by one pool inside height H's window,
 *                     plus a late re-send after the window and a blacklisted pool's template: neither counts
 * and invalid-coinbase findings: on B0 (height H: a badge on A and S1, the blacklisted offender left out) and on B1
 * (height H - 1, where nothing forked: a row of its own, keyed by B2).
 * Parent hashes are asymmetric (they meet the target only read in display order), so a byte-order slip fails here.
 * The summary is read through unknown_parent_pools, filled here (as the owner) by the function the backend calls
 * (unknown_parent_pools_refresh(), backend/unknown_parents.py), and compared field for field with the web's live
 * two-step read of templates (getLiveEpisodePoolRows). Covered: episodes, pools and a/b connections, counts, facts,
 * kinds, ranges in Bitcoin time (and the legacy 90d / 1y values), blacklist exclusion (counts, chips, drill-in, site names never returned), the drill-in's parent
 * labels and blocks, and extranonce1 masking.
 *
 * Shared database: other suites insert blocks too. The ranges are counted down from our tip (the highest best-chain
 * block), and an episode's tip is "the highest best block that had arrived by its template", so this suite's chain
 * (H) must be the highest. It sits above every other suite's heights except pgBlocksBest's top (9,000,000 +): both
 * suites hold the same advisory lock (TIP_LOCK) while their blocks exist, so with parallel files they run one after
 * the other, and the range test checks that H is the tip. Skipped unless a test database is configured:
 *
 *   PG_TEST_HOST=… PG_TEST_USER=web PG_TEST_PASSWORD=… PG_TEST_ADMIN_DSN=postgresql://… npm test
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { createMasker } from '../connectionMask';

const env = process.env;
const enabled = !!env.PG_TEST_HOST;
const KEY = 'pg-unknown-parents-test-key';
/** Held by the suites that seed a block above every other suite's (this one, pgBlocksBest): one tip at a time. */
const TIP_LOCK = 72_010_261;                // the same key in pgBlocksBest.test.ts

describe.skipIf(!enabled)('Postgres forks (stale and unknown parents, kinds, findings, drill-in)', () => {
  const run = Math.floor(Date.now() / 1000) % 40_000;
  const single = `wunk-${run}`;            // one connection
  const multi = `wunkm-${run}`;            // two connections (a, b)
  const hidden = `wunkx-${run}`;           // blacklisted
  const H = 8_000_000 + run * 20;          // our chain: best blocks at H - 2, H - 1, H; the race is at H - 1
  const HC = 5_000_000 + run * 20;         // the other chain's height
  const HD = 6_000_000 + run * 20;         // D's
  const HF = HD + 10;                      // F's
  const DAY = 86_400;
  const T0 = Math.floor(Date.now() / 1000) - 80 * DAY;   // the best block at H - 1 arrives (inside the 90-day window)
  const BITS = 0x207fffff;                 // target 0x7fffff << 232: a hash starting 00 meets it, one starting ff doesn't
  const OTHER_NBITS = 0x1d00ffff;
  const r3 = run.toString(16).padStart(6, '0');
  // display-order hashes; the last word is ff, so the stratum (word-reversed) order would start with ff and fail
  const X_A = '00' + r3 + '5a'.repeat(24) + 'ffffffff';
  const X_B = 'ff'.repeat(29) + r3;                          // all ff but this run's bytes (episodes are per parent)
  const X_C = '00000000' + r3 + '3c'.repeat(21) + 'ffffffff';
  const X_H = '00' + r3 + '77'.repeat(24) + 'ffffffff';       // only the blacklisted pool builds on it
  const X_D = '00000000' + r3 + '4d'.repeat(21) + 'ffffffff';
  const X_E = '00' + r3 + '8e'.repeat(24) + 'ffffffff';
  const X_F = '00000000' + r3 + '6f'.repeat(21) + 'ffffffff';
  const blk = (k: string) => '0000' + r3 + k.repeat(26) + '00';   // our blocks (display order)
  const [B2, B1, B0, S1] = [blk('b2'), blk('b1'), blk('b0'), blk('51')];  // H - 2, H - 1, H; S1: stale at H - 1
  const [E6, E26, E0] = [blk('e6'), blk('e2'), blk('e0')];   // the range cutoffs (H - 6, H - 26 epochs); E0: an early block, so F has a tip
  const EN1 = { [single]: 'c0ffee11', [`${multi}/a`]: 'c0ffee12', [`${multi}/b`]: 'c0ffee13', [hidden]: 'c0ffee14' } as Record<string, string>;
  const SITE = `zz-site-${run}`;
  const AUX = 'fabe6d6d' + 'ab'.repeat(32) + '0100000000000000';
  const cb1 = (scriptSigBytes: number) => '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff'
    + scriptSigBytes.toString(16).padStart(2, '0') + '0340420f';
  const CB1 = cb1(12);
  const CB2 = 'ffffffff0100f2052a01000000016a00000000';
  let route: typeof import('../../app/api/forks/route');
  let admin: Client;
  const sid: Record<string, number> = {};

  const insert = (src: string, s: number, height: number, job: string, parent: string, o: {
    nbits?: number; cb1?: string; ntime?: number } = {}) =>
    admin.query(
      `INSERT INTO templates (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2, merkle_branches,
                              version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length)
       VALUES (to_timestamp($1::float8), $2, $3, $4, stratum_prev_hash_to_block_hash(decode($5, 'hex')), decode($6, 'hex'),
               decode($7, 'hex'), decode(repeat('11', 32), 'hex'), 536870912, $8, $9, true, decode($10, 'hex'), 4)`,
      [T0 + s, sid[src], height, job, parent, o.cb1 ?? CB1, CB2, o.nbits ?? BITS, o.ntime ?? 1_790_000_000 + Math.floor(s),
       EN1[src]]);
  const block = (hash: string, height: number, arrival: number) => admin.query(
    `INSERT INTO blocks (block_hash, height, block_time, seen_at, coinbase_script_sig, bits)
     VALUES (decode($1, 'hex'), $2, to_timestamp($3::float8), to_timestamp($3::float8), '\\x00', $4)`,
    [hash, height, T0 + arrival, BITS]).then(() => undefined);

  const get = async (qs = '') => {
    const res = await route.GET(new Request(`http://localhost/api/forks${qs}`));
    return { status: res.status, text: await res.clone().text(), body: await res.json() };
  };
  type Ep = { parent: string; kind: string; height: number; templates: number; pools: { pool: string; connections: string[]; templates: number }[];
    facts: Record<string, unknown>; first_ms: number; last_ms: number; duration_ms: number; auxpow_templates: number | null;
    invalid_coinbase: { height: number; pools: { pool: string; templates: number; total_sats: number; subsidy_sats: number | null }[] } | null };
  const ALL = [X_A, X_B, X_C, X_H, X_D, X_E, X_F];
  const mine = (eps: Ep[]) => eps.filter(e => ALL.includes(e.parent));
  let db: typeof import('../db/unknown-parents');

  beforeAll(async () => {
    vi.resetModules();
    Object.assign(process.env, {
      PG_HOST: env.PG_TEST_HOST, PG_PORT: env.PG_TEST_PORT ?? '5432', PG_DATABASE: env.PG_TEST_DATABASE ?? 'stratum',
      PG_USER: env.PG_TEST_USER, PG_PASSWORD: env.PG_TEST_PASSWORD, PG_SSLMODE: 'disable',
      POOL_BLACKLIST: hidden, EXTRANONCE1_MASK_KEY: KEY,
    });
    admin = new Client({ connectionString: env.PG_TEST_ADMIN_DSN });   // the web role can't write; insert as admin
    await admin.connect();
    await admin.query('SELECT pg_advisory_lock($1)', [TIP_LOCK]);   // released when admin disconnects (afterAll)
    // multi's b is registered first (a lower id): the letters follow (site, replica), not ids
    for (const [pool, replica] of [[single, 'a'], [multi, 'b'], [multi, 'a'], [hidden, 'a']]) {
      const r = await admin.query(
        `INSERT INTO sources (name, site, replica) VALUES ($1, $2, $3)
         ON CONFLICT (name, site, replica) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [pool, SITE, replica]);
      sid[pool === multi ? `${pool}/${replica}` : pool] = r.rows[0].id;
    }
    // our chain: H - 2 long before, H - 1 at T0, H at T0 + 120; a recorded stale block S1 at H - 1
    await block(B2, H - 2, -600);
    await block(B1, H - 1, 0);
    await block(B0, H, 120);
    // the ranges' cutoffs: 6 epochs below arrived 10 days before T0 (90 days ago), 26 epochs below 150 days before
    await block(E6, H - 12_096, -10 * DAY);
    await block(E26, H - 52_416, -150 * DAY);
    await block(E0, H - 60_000, -250 * DAY);   // before F: an episode with no block before it has no tip and isn't shown
    await admin.query(
      `INSERT INTO stale_blocks (block_hash, height, prev_hash, version, block_time, bits, nonce, merkle_root,
                                 chaintip_status, last_status, tip_hash, fork_height, first_seen)
       VALUES (decode($1, 'hex'), $2, decode($3, 'hex'), 1, to_timestamp($4::float8), $5, 1, '\\x00', 'valid-fork',
               'valid-fork', decode($1, 'hex'), $2 - 1, to_timestamp($4::float8))`, [S1, H - 1, B2, T0 + 5, BITS]);
    await admin.query(`UPDATE stale_blocks SET mining_pool = $2::jsonb WHERE block_hash = decode($1, 'hex')`,
      [S1, JSON.stringify({ name: 'Synthetic Miner' })]);
    // findings: invalid coinbases at H (A and S1 raced there) and at H - 1 (nothing forked there)
    const offender = (pool: string, total: number) => ({ pool_name: pool, total_sats: total, subsidy_sats: 312_500_000 });
    const finding = (offenders: object[]) => JSON.stringify({ flags: [{ key: 'invalid_coinbase_no_merkle', icon: 'error', details: { offenders } }] });
    await admin.query(`UPDATE blocks SET analysis = $2::jsonb WHERE block_hash = decode($1, 'hex')`,
      [B0, finding([offender(single, 328_000_000), offender(single, 328_000_000), offender(hidden, 330_000_000)])]);
    await admin.query(`UPDATE blocks SET analysis = $2::jsonb WHERE block_hash = decode($1, 'hex')`,
      [B1, finding([offender(single, 327_000_000)])]);

    // A: at height H on X_A (the competitor of B1), T0 + 5 .. T0 + 65
    await insert(single, 5, H, 'a1', X_A);
    await insert(single, 65, H, 'a2', X_A, { cb1: cb1(56) + AUX });
    await insert(`${multi}/a`, 10, H, 'm1', X_A, { ntime: 1_790_000_100 });
    await insert(`${multi}/b`, 10.5, H, 'n1', X_A, { ntime: 1_790_000_100 });   // exact copy of m1: counted once
    await insert(`${multi}/b`, 40, H, 'n2', X_A);                                 // only on connection b
    await insert(hidden, 1, H, 'x1', X_A);        // blacklisted, and first: a leak would show in counts, chips and first_ms
    // Bitcoin work around it (drill-in labels): on B1 (best), on S1 (stale), then on B0 (best) at H + 1
    await insert(single, 2, H, 'w1', B1);
    await insert(`${multi}/a`, 30, H, 'w2', S1);
    await insert(`${multi}/a`, 120 + 3 * 3600, H, 'w5', S1);  // a late re-send of work on S1, after height H's window
    await insert(hidden, 31, H, 'x3', S1);                    // blacklisted
    await insert(single, 130, H + 1, 'w3', B0);
    await insert(`${multi}/a`, 3, H, 'w4', B1);
    // B: the all-ff parent at H + 1, T0 + 300 .. T0 + 320
    await insert(single, 300, H + 1, 'b1', X_B);
    await insert(single, 320, H + 1, 'b2', X_B);
    // C: another chain, far below our tip, other nbits
    await insert(`${multi}/a`, 1000, HC, 'c1', X_C, { nbits: OTHER_NBITS });
    await insert(`${multi}/a`, 1003, HC, 'c2', X_C, { nbits: OTHER_NBITS });
    await insert(`${multi}/a`, 1004, HC + 1, 'c3', X_C, { nbits: OTHER_NBITS }); // a second height, outvoted
    // only the blacklisted pool: no episode at all
    await insert(hidden, 2000, HC, 'x2', X_H, { nbits: OTHER_NBITS });
    // D: 200 days ago (120 days before T0): between the cutoffs
    await insert(single, -120 * DAY, HD, 'd1', X_D, { nbits: OTHER_NBITS });
    await insert(single, -120 * DAY + 30, HD, 'd2', X_D, { nbits: OTHER_NBITS });
    // F: 280 days ago (200 days before T0): before the 26-epoch cutoff
    await insert(single, -200 * DAY, HF, 'f1', X_F, { nbits: OTHER_NBITS });
    // E: unknown when the summary is written
    await insert(single, 3000, HC, 'e1', X_E, { nbits: OTHER_NBITS });
    // the summary, as the backend writes it: each parent recomputed from all its templates
    await admin.query(
      `SELECT unknown_parent_pools_refresh(x.prev_hash, x.heights, x.t_from, x.t_to)
         FROM (SELECT prev_hash, array_agg(DISTINCT height) AS heights, min(received_at) AS t_from, max(received_at) AS t_to
                 FROM templates WHERE prev_hash = ANY (SELECT stratum_prev_hash_to_block_hash(decode(h, 'hex')) FROM unnest($1::text[]) h)
                GROUP BY prev_hash) x`, [ALL]);
    route = await import('../../app/api/forks/route');
    db = await import('../db/unknown-parents');
  }, 120_000);                                   // may wait for the other suite's tip lock

  afterAll(async () => {
    await admin?.query(
      `DELETE FROM unknown_parent_pools WHERE prev_hash = ANY (SELECT stratum_prev_hash_to_block_hash(decode(h, 'hex')) FROM unnest($1::text[]) h)`,
      [ALL]);
    await admin?.query(`DELETE FROM blocks WHERE block_hash = decode($1, 'hex')`, [X_E]);
    await admin?.query(`DELETE FROM stale_blocks WHERE height = $1`, [H - 1]);
    await admin?.query(`DELETE FROM blocks WHERE height = ANY ($1::int[])`, [[H - 2, H - 1, H, H - 12_096, H - 52_416, H - 60_000]]);
    await admin?.end();
    const { getPgPool } = await import('../db/pg');
    await getPgPool().end();
  });

  it('stores what the live read of templates returns, field for field (with and without the blacklist)', async () => {
    const pick = (rows: { parent: string }[]) => rows.filter(r => [X_A, X_B, X_C, X_H].includes(r.parent));
    for (const excluded of [[], [hidden]]) {
      const live = pick(await db.getLiveEpisodePoolRows(excluded));
      expect(live.length).toBeGreaterThanOrEqual(excluded.length ? 4 : 6);
      expect(pick(await db.getEpisodePoolRows(excluded, '6e'))).toEqual(live);
    }
  });

  it('judges "unknown" at read time: a parent recorded as a block later drops out, its row untouched', async () => {
    const has = async () => (await db.getEpisodePoolRows([], 'all')).some(r => r.parent === X_E);
    expect(await has()).toBe(true);
    await admin.query(`INSERT INTO blocks (block_hash, height, block_time, coinbase_script_sig) VALUES (decode($1, 'hex'), $2, now(), '\\x00')`,
      [X_E, HC - 1]);
    expect(await has()).toBe(false);
    const stored = await admin.query(
      `SELECT n FROM unknown_parent_pools WHERE prev_hash = stratum_prev_hash_to_block_hash(decode($1, 'hex'))`, [X_E]);
    expect(stored.rows).toEqual([{ n: 1 }]);
    await admin.query(`DELETE FROM blocks WHERE block_hash = decode($1, 'hex')`, [X_E]);
  });

  it('reads 6 or 26 epochs below our tip, or all history', async () => {
    const tip = (await admin.query(`SELECT max(height) AS tip FROM blocks_best`)).rows[0].tip;
    expect(tip, 'another suite\'s block is above this suite\'s tip (see TIP_LOCK)').toBe(H);
    const parents = async (qs: string) => mine((await get(qs)).body.episodes).map(e => e.parent).filter(p => p !== X_E);
    expect(await parents('')).toEqual([X_A, X_B, X_C]);
    expect(await parents('?range=26e')).toEqual([X_D, X_A, X_B, X_C]);
    expect(await parents('?range=all')).toEqual([X_F, X_D, X_A, X_B, X_C]);
    expect(await parents('?range=90d')).toEqual([X_A, X_B, X_C]);              // the legacy values: 6e and 26e
    expect(await parents('?range=1y')).toEqual([X_D, X_A, X_B, X_C]);
    expect((await get('?range=26e')).body).toMatchObject({ range: '26e', blocks: 52_416, tip_height: H, from_height: H - 52_416 });
    expect((await get('?range=1y')).body).toMatchObject({ range: '26e' });
    const all = (await get('?range=all')).body;
    expect(all).toMatchObject({ range: 'all', blocks: null, tip_height: H });
    expect(all.from_height).toBeLessThanOrEqual(H - 52_416);    // D's tip; other suites' episodes may sit lower
    expect((await get(`?parent=${X_D}`)).status).toBe(404);
    expect((await get(`?parent=${X_D}&range=26e`)).status).toBe(200);
    expect((await get(`?parent=${X_F}&range=26e`)).status).toBe(404);
    expect((await get(`?parent=${X_F}&range=all`)).status).toBe(200);
  });

  it('groups the window into episodes with pools, a/b connections and counts', async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toMatchObject({ enabled: true, supported: true, range: '6e', blocks: 12_096, tip_height: H,
      from_height: H - 12_096 });
    const eps = mine(body.episodes).filter(e => e.parent !== X_E);
    expect(eps.map(e => e.parent)).toEqual([X_A, X_B, X_C]);               // oldest first; X_H (blacklisted only) absent
    const [a, b, c] = eps;
    expect(a).toMatchObject({
      height: H, templates: 4, auxpow_templates: 1, first_ms: (T0 + 5) * 1000, last_ms: (T0 + 65) * 1000,
      duration_ms: 60_000,
      pools: [{ pool: single, connections: ['a'], templates: 2 }, { pool: multi, connections: ['a', 'b'], templates: 2 }],
    });
    expect(b).toMatchObject({ height: H + 1, templates: 2, pools: [{ pool: single, connections: ['a'], templates: 2 }] });
    expect(c).toMatchObject({ height: HC, templates: 3, pools: [{ pool: multi, connections: ['a'], templates: 3 }] });
    expect((c as unknown as { heights: number[] }).heights).toEqual([HC, HC + 1]);
  });

  it('reads the facts and infers one kind of each', async () => {
    const [a, b, c] = mine((await get()).body.episodes);   // E (later) sorts last
    const bits = BITS.toString(16);
    expect(a.kind).toBe('bitcoin_block');
    expect(a.facts).toEqual({
      tip_at_first: H - 1, tip_at_last: H - 1, tip_offset: 0, nbits: [bits], bitcoin_bits: bits, bitcoin_bits_at: bits,
      bitcoin_difficulty: true, pow_ok: true, pow_bits: bits, in_stale_blocks: false, stale_block: null,
    });
    expect(b.kind).toBe('invalid_parent');
    expect(b.facts).toMatchObject({ tip_at_first: H, tip_at_last: H, tip_offset: 0, bitcoin_bits: bits, bitcoin_difficulty: true, pow_ok: false });
    expect(c.kind).toBe('other_chain');
    expect(c.facts).toMatchObject({
      tip_at_first: H, tip_at_last: H, tip_offset: HC - 1 - H, nbits: ['1d00ffff'], bitcoin_bits: null, bitcoin_difficulty: null,
      pow_ok: true, pow_bits: '1d00ffff',                                  // meets its own target: still not Bitcoin's
    });
  });

  it('leaves the blacklisted pool out: counts, chips, episodes, and never returns site names', async () => {
    const { text, body } = await get();
    expect(text).not.toContain(hidden);
    expect(text).not.toContain(SITE);
    expect(body.episodes.some((e: Ep) => e.parent === X_H)).toBe(false);
    expect((await get(`?parent=${X_H}`)).status).toBe(404);
    const drill = await get(`?parent=${X_A}`);
    expect(drill.text).not.toContain(hidden);
    expect(drill.text).not.toContain(SITE);
    expect(drill.text).not.toContain(EN1[hidden]);
  });

  it('drills into an episode: its pools at H - 1 .. H + 1 around its minutes, labelled by parent, with the blocks', async () => {
    const { status, body } = await get(`?parent=${X_A.toUpperCase()}`);
    expect(status).toBe(200);
    expect(body.episode.parent).toBe(X_A);
    expect(body.from_ms).toBe((T0 + 5) * 1000 - 300_000);
    expect(body.to_ms).toBe((T0 + 65) * 1000 + 300_000);
    expect(body.truncated).toBe(false);
    const got = body.templates.map((t: { id: string; parent: string; connections: string[]; copies: number }) =>
      [t.id.split('-').pop(), t.parent, t.connections.join(''), t.copies]);
    expect(got).toEqual([
      ['w1', 'best', 'a', 1], ['w4', 'best', 'a', 1], ['a1', 'this', 'a', 1], ['m1', 'this', 'ab', 2], ['w2', 'stale', 'a', 1],
      ['n2', 'this', 'b', 1], ['a2', 'this', 'a', 1], ['w3', 'best', 'a', 1], ['b1', 'other', 'a', 1], ['b2', 'other', 'a', 1],
    ]);
    expect(body.blocks).toEqual([
      { hash: B1, height: H - 1, arrival_ms: T0 * 1000, best: true },
      { hash: S1, height: H - 1, arrival_ms: (T0 + 5) * 1000, best: false },
      { hash: B0, height: H, arrival_ms: (T0 + 120) * 1000, best: true },
    ]);
    const a2 = body.templates.find((t: { id: string }) => t.id.endsWith('-a2'));
    expect(a2).toMatchObject({ auxpow: true, auxpow_root: 'ab'.repeat(32), prev_hash: X_A, height: H, scriptsig_height: 1_000_000 });
  });

  it('serves the recorded stale block S1 as a stale episode: its pool inside the window, not the blacklisted one', async () => {
    for (const range of ['', '?range=26e', '?range=all']) {
      const { body, text } = await get(range);
      const s = (body.episodes as Ep[]).filter(e => e.parent === S1);
      expect(s, range).toHaveLength(1);
      expect(s[0]).toMatchObject({
        kind: 'stale', height: H, heights: [H], templates: 1, auxpow_templates: null,
        first_ms: (T0 + 30) * 1000, last_ms: (T0 + 30) * 1000,       // the late re-send (w5) is outside H's window
        pools: [{ pool: multi, connections: ['a'], templates: 1 }],
      });
      expect(s[0].facts).toMatchObject({
        tip_at_first: H - 1, tip_offset: 0, in_stale_blocks: true, pow_ok: true, bitcoin_difficulty: true,
        stale_block: { height: H - 1, header_source: 'node', miner: 'Synthetic Miner' },
      });
      expect(text).not.toContain(hidden);
    }
    // its drill-in: S1 is "this parent"
    const drill = await get(`?parent=${S1}`);
    expect(drill.status).toBe(200);
    const labels = Object.fromEntries(drill.body.templates.map((t: { id: string; parent: string }) => [t.id.split('-').pop(), t.parent]));
    expect(labels).toMatchObject({ w2: 'this', m1: 'other', w4: 'best' });   // the episode's pool only
    expect(drill.text).not.toContain(hidden);
    // a stale block reorged back in is our best block again: no episode
    await admin.query(`UPDATE stale_blocks SET reorged_in_at = now() WHERE block_hash = decode($1, 'hex')`, [S1]);
    expect((await db.getStaleEpisodePoolRows([hidden], 'all')).some(r => r.parent === S1)).toBe(false);
    await admin.query(`UPDATE stale_blocks SET reorged_in_at = NULL WHERE block_hash = decode($1, 'hex')`, [S1]);
    expect((await db.getStaleEpisodePoolRows([hidden], 'all')).filter(r => r.parent === S1).map(r => r.pool)).toEqual([multi]);
  });

  it('does not name a stale block\'s miner that is a blacklisted pool, in the summary or the drill-in', async () => {
    await admin.query(`UPDATE stale_blocks SET mining_pool = $2::jsonb WHERE block_hash = decode($1, 'hex')`,
      [S1, JSON.stringify({ name: hidden })]);
    try {
      // the episodes as the route builds them (its summary is cached per range), and the drill-in
      const up = await import('../unknownParents');
      const eps = await up.getEpisodes([hidden], 'all');
      const s1 = eps.find(e => e.parent === S1)!;
      expect(s1.facts.stale_block).toEqual({ height: H - 1, header_source: 'node', miner: null });
      expect(JSON.stringify(eps)).not.toContain(hidden);
      expect(JSON.stringify(await up.getDrill(s1, [hidden]))).not.toContain(hidden);
    } finally {
      await admin.query(`UPDATE stale_blocks SET mining_pool = $2::jsonb WHERE block_hash = decode($1, 'hex')`,
        [S1, JSON.stringify({ name: 'Synthetic Miner' })]);
    }
  });

  it('badges the episodes at a finding\'s height, and makes one with no episode there a row of its own', async () => {
    const eps = (await get()).body.episodes as Ep[];
    const badge = { height: H, pools: [{ pool: single, templates: 2, total_sats: 328_000_000, subsidy_sats: 312_500_000 }] };
    expect(eps.find(e => e.parent === X_A)!.invalid_coinbase).toEqual(badge);
    expect(eps.find(e => e.parent === S1)!.invalid_coinbase).toEqual(badge);
    expect(eps.find(e => e.parent === X_B)!.invalid_coinbase).toBeNull();    // H + 1
    expect(eps.find(e => e.parent === X_C)!.invalid_coinbase).toBeNull();    // another chain
    const row = eps.find(e => e.kind === 'invalid_coinbase' && e.height === H - 1);
    expect(row).toMatchObject({
      parent: B2, heights: [H - 1], templates: 1, pools: [{ pool: single, connections: [], templates: 1 }],
      first_ms: (T0 - 600) * 1000, last_ms: T0 * 1000, facts: { tip_at_first: H - 2, tip_offset: 0 },
      invalid_coinbase: { height: H - 1, pools: [{ pool: single, templates: 1, total_sats: 327_000_000 }] },
    });
    const drill = await get(`?parent=${B2}`);
    expect(drill.status).toBe(200);
    expect(drill.body.templates.every((t: { parent: string }) => t.parent !== 'this')).toBe(true);
    expect(drill.body.templates.map((t: { id: string }) => t.id.split('-').pop())).toContain('w1');
  });

  it('answers on the alias /api/unknown-parents too', async () => {
    const alias = await import('../../app/api/unknown-parents/route');
    const res = await alias.GET(new Request('http://localhost/api/unknown-parents?range=all'));
    expect(res.status).toBe(200);
    expect(((await res.json()).episodes as Ep[]).some(e => e.parent === S1 && e.kind === 'stale')).toBe(true);
  });

  it('rejects a malformed parent and 404s an unknown one', async () => {
    expect((await get('?parent=xyz')).status).toBe(400);
    expect((await get(`?parent=${'0'.repeat(63)}`)).status).toBe(400);
    expect((await get(`?parent=${'12'.repeat(32)}`)).status).toBe(404);
  });

  it('masks extranonce1', async () => {
    const mask = createMasker(KEY);
    const { body, text } = await get(`?parent=${X_A}`);
    for (const raw of Object.values(EN1)) expect(text).not.toContain(raw);
    for (const t of body.templates as { pool_name: string; id: string; extranonce1: string }[]) {
      const src = t.pool_name === multi ? `${multi}/${t.id.split('-').pop()!.startsWith('n') ? 'b' : 'a'}` : t.pool_name;
      expect(t.extranonce1).toBe(mask(t.pool_name, EN1[src]));
    }
  });
});
