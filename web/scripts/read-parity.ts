/**
 * Read parity (#113): call the API route handlers with DB_BACKEND=mongodb and DB_BACKEND=postgres and compare the
 * JSON they return, for reads R1–R7 (docs/design/postgres-timescale.md, section 1).
 *
 *   DATABASE_URL=mongodb://…  PG_HOST=… PG_USER=… PG_PASSWORD=… npm run parity -- [--heights a-b|a,b,…] [--json file]
 *
 * Without --heights it checks every height from the lowest one Postgres has templates for up to the tip.
 *
 * Differences that are expected by design are normalized and counted, not reported as mismatches:
 *  - template `id`: MongoDB's UUID vs Postgres's `<source_id>-<µs>-<job_id>` (see lib/db/pg-mapping.ts)
 *  - template `timestamp`: Postgres keeps µs, so the sub-µs part of MongoDB's hex-ns value is zero. Templates are
 *    matched on (pool, µs); a ±1 µs difference (the collector's float conversion) is counted separately
 *  - block `_id`/`id`: MongoDB's ObjectId (rendered as "[object Object]" in `id`) vs the block hash
 *  - pool `id`: MongoDB's ObjectId vs the mining-pools id
 *  - JSON key order inside jsonb (analysis, mining_pool): compared order-insensitively
 * Templates present in only one database are classified: before Postgres collection started for that source, routed
 * to templates_other by the collector (height_implausible / height_parse_failed / …), or unexplained.
 */
import { writeFileSync } from 'fs';
import { NextRequest } from 'next/server';
import { GET as miningNotifyGET } from '../app/api/mining-notify/route';
import { GET as analysisGET } from '../app/api/analysis-data/route';
import { GET as firstSeenGET } from '../app/api/block-pool-first-seen/route';
import { GET as blocksGET } from '../app/api/blocks/route';
import { GET as poolsGET } from '../app/api/pools/route';
import { getBlockByHash } from '../lib/db/blocks';
import { getPgPool } from '../lib/db/pg';

type Json = unknown;
type Backend = 'mongodb' | 'postgres';
const BASE = 'http://parity.local';

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────

async function withBackend<T>(backend: Backend, fn: () => Promise<T>): Promise<T> {
  process.env.DB_BACKEND = backend;
  return fn();
}

async function callRoute(backend: Backend, handler: (req: NextRequest) => Promise<Response>, path: string) {
  return withBackend(backend, async () => {
    const res = await handler(new NextRequest(`${BASE}${path}`));
    return { status: res.status, body: (await res.json()) as Json };
  });
}

function canonical(v: Json): Json {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as object).sort().map(k => [k, canonical((v as Record<string, Json>)[k])]));
  }
  return v;
}

/** Paths where a and b differ (order-insensitive for object keys), at most `limit`. */
function diffPaths(a: Json, b: Json, path = '$', out: string[] = [], limit = 10): string[] {
  if (out.length >= limit) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}.length ${a.length} vs ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diffPaths(a[i], b[i], `${path}[${i}]`, out, limit);
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of [...keys].sort()) {
      diffPaths((a as Record<string, Json>)[k], (b as Record<string, Json>)[k], `${path}.${k}`, out, limit);
    }
    return out;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push(`${path}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`);
  }
  return out;
}

function keyOrderDiffers(a: Json, b: Json): boolean {
  return JSON.stringify(a) !== JSON.stringify(b) && JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

const nsToUs = (hexNs: string) => BigInt(`0x${hexNs}`) / BigInt(1000);

// ── results ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface ReadResult {
  read: string;
  checks: number;          // responses (or heights) compared
  match: number;           // identical after the expected normalizations
  mismatch: number;        // unexplained differences
  expected: Record<string, number>;
  examples: string[];
}

const results: Record<string, ReadResult> = {};
function result(read: string): ReadResult {
  return (results[read] ??= { read, checks: 0, match: 0, mismatch: 0, expected: {}, examples: [] });
}
function expected(r: ReadResult, what: string, n = 1) {
  if (n > 0) r.expected[what] = (r.expected[what] ?? 0) + n;
}
function mismatch(r: ReadResult, what: string) {
  r.mismatch++;
  if (r.examples.length < 15) r.examples.push(what);
}

// ── template matching (R1, R2) ───────────────────────────────────────────────────────────────────────────────────

interface Ctx {
  // per source name: earliest received_at (µs) in Postgres, either table
  pgStart: Map<string, bigint>;
  // per source name: lowest height in `templates` (that height is partial: collection started during it)
  firstPgHeight: Map<string, number>;
}

/** (pool, µs) → templates_other reason, for templates the collector didn't put in `templates`. */
async function templatesOtherAt(height: number): Promise<Map<string, string>> {
  const { rows } = await getPgPool().query(
    `SELECT s.name, (extract(epoch FROM t.received_at) * 1000000)::bigint AS us, t.reason
       FROM templates_other t JOIN sources s ON s.id = t.source_id WHERE t.height = $1`, [height]);
  return new Map(rows.map(r => [`${r.name}|${r.us}`, r.reason as string]));
}

type Tpl = Record<string, Json> & { pool_name: string; timestamp: string };

/** Compare two template lists. Returns true if they match (after the expected normalizations). */
async function compareTemplates(r: ReadResult, height: number, mongo: Tpl[], pg: Tpl[], ctx: Ctx, btcOnly: boolean) {
  let ok = true;
  // Several templates can share (pool, µs): the collector stamps every notification from one socket read with the
  // same receive time. So keep a list per key and pick the candidate with identical content.
  const pgByKey = new Map<string, Tpl[]>();
  for (const t of pg) {
    const k = `${t.pool_name}|${nsToUs(t.timestamp)}`;
    pgByKey.set(k, [...(pgByKey.get(k) ?? []), t]);
  }
  const other = await templatesOtherAt(height);
  const matchedPg = new Set<Tpl>();
  const mongoOrder: Tpl[] = [];
  const content = (t: Tpl) => { const { id: _i, timestamp: _t, chain_family: _c, ...rest } = t; void _i; void _t; void _c; return rest; };

  const pick = (m: Tpl, us: bigint): Tpl | undefined => {
    const candidates = (pgByKey.get(`${m.pool_name}|${us}`) ?? []).filter(c => !matchedPg.has(c));
    return candidates.find(c => diffPaths(content(m), content(c), '$', [], 1).length === 0) ?? candidates[0];
  };

  for (const m of mongo) {
    const us = nsToUs(m.timestamp);
    let p = pick(m, us);
    if (!p) {
      for (const d of [BigInt(-1), BigInt(1)]) {
        const q = pick(m, us + d);
        if (q) { p = q; expected(r, 'timestamp off by 1 µs (collector float rounding)'); break; }
      }
    }
    if (!p) {
      const start = ctx.pgStart.get(m.pool_name);
      const reason = other.get(`${m.pool_name}|${us}`);
      if (start === undefined || us < start) expected(r, 'MongoDB-only: before Postgres collection started');
      else if (reason && btcOnly) expected(r, `MongoDB-only: collector routed to templates_other (${reason})`);
      else { ok = false; mismatch(r, `h=${height} MongoDB-only template ${m.pool_name} ts=${m.timestamp}`); }
      continue;
    }
    matchedPg.add(p);
    mongoOrder.push(p);
    if (m.timestamp !== p.timestamp) expected(r, 'timestamp sub-µs digits (Postgres keeps µs)');
    if (m.id !== p.id) expected(r, 'template id (no MongoDB _id in Postgres)');
    const { id: _a, timestamp: _b, ...mRest } = m;
    const { id: _c, timestamp: _d, ...pRest } = p;
    void _a; void _b; void _c; void _d;
    if (!btcOnly && m.chain_family === undefined && typeof p.chain_family === 'string') {
      // R2: MongoDB says Bitcoin (no chain_family) but the collector routed it to templates_other.
      const reason = other.get(`${p.pool_name}|${nsToUs(p.timestamp)}`) ?? '?';
      expected(r, `chain_family set: collector routed to templates_other (${reason})`);
      delete (pRest as Record<string, Json>).chain_family;
    }
    const d = diffPaths(mRest, pRest);
    if (d.length) { ok = false; mismatch(r, `h=${height} ${m.pool_name} ts=${m.timestamp}: ${d.join('; ')}`); }
    else if (keyOrderDiffers(mRest, pRest)) expected(r, 'key order');
  }
  for (const p of pg) {
    if (!matchedPg.has(p)) { ok = false; mismatch(r, `h=${height} Postgres-only template ${p.pool_name} ts=${p.timestamp}`); }
  }
  // Order: MongoDB has no ORDER BY (natural order ≈ insertion order); Postgres orders by received_at.
  // The UI sorts rows itself, so order is informational: count whether it differs only among same-µs ties.
  const pgOrder = pg.filter(p => matchedPg.has(p));
  if (mongoOrder.some((p, i) => p !== pgOrder[i])) {
    const us = (t: Tpl) => nsToUs(t.timestamp);
    const outOfTimeOrder = mongoOrder.some((p, i) => i > 0 && us(p) + BigInt(1) < us(mongoOrder[i - 1]));
    expected(r, outOfTimeOrder
      ? 'template order differs: MongoDB natural (insertion) order isn\'t receive-time order'
      : 'template order differs only among templates received in the same µs');
  }
  return ok;
}

// ── reads ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function r1(height: number, ctx: Ctx) {
  const r = result('R1 /api/mining-notify');
  const [m, p] = await Promise.all([
    callRoute('mongodb', miningNotifyGET, `/api/mining-notify?height=${height}`),
    callRoute('postgres', miningNotifyGET, `/api/mining-notify?height=${height}`),
  ]);
  r.checks++;
  if (m.status !== p.status) { mismatch(r, `h=${height} status ${m.status} vs ${p.status}`); return; }
  if (await compareTemplates(r, height, m.body as Tpl[], p.body as Tpl[], ctx, true)) r.match++;
}

function normalizeBlock(b: Json, r: ReadResult): Json {
  if (!b || typeof b !== 'object') return b;
  const copy = { ...(b as Record<string, Json>) };
  if ('_id' in copy) { expected(r, 'block _id (MongoDB ObjectId)'); delete copy._id; }
  if ('id' in copy) delete copy.id;
  return copy;
}

async function r2(height: number, ctx: Ctx) {
  const r = result('R2 /api/analysis-data?height');
  const [m, p] = await Promise.all([
    callRoute('mongodb', analysisGET, `/api/analysis-data?height=${height}`),
    callRoute('postgres', analysisGET, `/api/analysis-data?height=${height}`),
  ]);
  r.checks++;
  if (m.status !== p.status) { mismatch(r, `h=${height} status ${m.status} vs ${p.status}`); return; }
  const mr = (m.body as { results: Record<string, Json>[] }).results[0];
  const pr = (p.body as { results: Record<string, Json>[] }).results[0];
  let ok = await compareTemplates(r, height, mr.mining_notifications as Tpl[], pr.mining_notifications as Tpl[], ctx, false);
  for (const k of ['height', 'block_details', 'previous_block']) {
    const d = diffPaths(mr[k], pr[k]);
    if (d.length) { ok = false; mismatch(r, `h=${height} ${k}: ${d.join('; ')}`); }
  }
  if (ok) r.match++;
}

async function r3() {
  const r = result('R3 /api/analysis-data?interesting');
  const [m, p] = await Promise.all([
    callRoute('mongodb', analysisGET, '/api/analysis-data?interesting=true'),
    callRoute('postgres', analysisGET, '/api/analysis-data?interesting=true'),
  ]);
  r.checks++;
  const mi = (m.body as { items: Json[] }).items;
  const pi = (p.body as { items: Json[] }).items;
  // Postgres only has blocks the Postgres backend has processed: compare the heights both have.
  const pgHeights = new Set(pi.map(i => (i as { height: number }).height));
  const mineComparable = mi.filter(i => pgHeights.has((i as { height: number }).height));
  expected(r, 'MongoDB-only items (blocks older than the Postgres backend\'s sync)', mi.length - mineComparable.length);
  const d = diffPaths(mineComparable, pi);
  if (d.length) mismatch(r, d.join('; '));
  else {
    r.match++;
    if (keyOrderDiffers(mineComparable, pi)) expected(r, 'key order (jsonb)');
  }
  expected(r, `items compared`, pi.length);
}

async function r4(height: number, ctx: Ctx) {
  const r = result('R4 /api/block-pool-first-seen');
  const [m, p] = await Promise.all([
    callRoute('mongodb', firstSeenGET, `/api/block-pool-first-seen?height=${height}`),
    callRoute('postgres', firstSeenGET, `/api/block-pool-first-seen?height=${height}`),
  ]);
  r.checks++;
  if (m.status !== p.status) { mismatch(r, `h=${height} status ${m.status} vs ${p.status}`); return; }
  type Item = { poolName: string; firstSeenTimestamp: string } & Record<string, Json>;
  const mi = m.body as Item[];
  const pi = p.body as Item[];
  let ok = true;
  // A first-seen (or a reliable flag at h, which depends on h-1) can only match once Postgres collection started.
  const covered = (pool: string, h: number) => {
    const start = ctx.pgStart.get(pool);
    return start !== undefined && (ctx.firstPgHeight.get(pool) ?? Infinity) < h;
  };
  for (const mItem of mi) {
    const pItem = pi.find(x => x.poolName === mItem.poolName);
    if (!covered(mItem.poolName, height)) {
      if (!pItem || diffPaths(mItem, pItem).length) expected(r, 'pool not yet collected into Postgres at h or h-1');
      continue;
    }
    if (!pItem) { ok = false; mismatch(r, `h=${height} ${mItem.poolName} missing in Postgres`); continue; }
    const mUs = nsToUs(mItem.firstSeenTimestamp), pUs = nsToUs(pItem.firstSeenTimestamp);
    if (mUs !== pUs && !(mUs - pUs === BigInt(1) || pUs - mUs === BigInt(1))) {
      ok = false; mismatch(r, `h=${height} ${mItem.poolName} first seen ${mItem.firstSeenTimestamp} vs ${pItem.firstSeenTimestamp}`);
    } else if (mItem.firstSeenTimestamp !== pItem.firstSeenTimestamp) {
      expected(r, mUs === pUs ? 'timestamp sub-µs digits (Postgres keeps µs)' : 'timestamp off by 1 µs (collector float rounding)');
    }
    const d = diffPaths({ ...mItem, firstSeenTimestamp: 0 }, { ...pItem, firstSeenTimestamp: 0 });
    if (d.length) { ok = false; mismatch(r, `h=${height} ${mItem.poolName}: ${d.join('; ')}`); }
  }
  for (const pItem of pi) {
    if (!mi.some(x => x.poolName === pItem.poolName)) { ok = false; mismatch(r, `h=${height} ${pItem.poolName} only in Postgres`); }
  }
  // Order: pools first seen within the same µs (±1) can't be ordered at Postgres's precision; anything else is a bug.
  const comparable = (xs: Item[]) => xs.filter(x => covered(x.poolName, height));
  const mOrder = comparable(mi), pOrder = comparable(pi);
  if (mOrder.map(x => x.poolName).join(',') !== pOrder.map(x => x.poolName).join(',')) {
    const us = new Map(mOrder.map(x => [x.poolName, nsToUs(x.firstSeenTimestamp)]));
    const tiesOnly = pOrder.every((x, i) => {
      if (x.poolName === mOrder[i]?.poolName) return true;
      const a = us.get(x.poolName), b = us.get(mOrder[i]?.poolName ?? '');
      return a !== undefined && b !== undefined && (a > b ? a - b : b - a) <= BigInt(1);
    });
    if (tiesOnly) expected(r, 'order of pools first seen in the same µs');
    else { ok = false; mismatch(r, `h=${height} order ${mOrder.map(x => x.poolName)} vs ${pOrder.map(x => x.poolName)}`); }
  }
  if (ok) r.match++;
}

async function compareBlocksResponse(r: ReadResult, label: string, path: string, pgMin: number) {
  const [m, p] = await Promise.all([callRoute('mongodb', blocksGET, path), callRoute('postgres', blocksGET, path)]);
  r.checks++;
  if (m.status !== p.status) { mismatch(r, `${label}: status ${m.status} vs ${p.status}`); return; }
  type Resp = { blocks: Json[]; has_more: boolean; next_height: number | null };
  const mb = m.body as Resp, pb = p.body as Resp;
  // Postgres blocks start where the Postgres backend's sync started; MongoDB has more history.
  const inPg = (b: Json) => (b as { height: number }).height >= pgMin;
  const mBlocks = mb.blocks.filter(inPg).map(b => normalizeBlock(b, r));
  const pBlocks = pb.blocks.map(b => normalizeBlock(b, r));
  expected(r, 'MongoDB-only blocks below the Postgres sync start', mb.blocks.length - mBlocks.length);
  const truncated = mb.blocks.length !== mBlocks.length;
  const d = diffPaths(mBlocks, pBlocks);
  const pageDiff = !truncated && (mb.has_more !== pb.has_more || mb.next_height !== pb.next_height);
  if (d.length || pageDiff) {
    mismatch(r, `${label}: ${d.join('; ')}${pageDiff ? ` paging ${mb.has_more}/${mb.next_height} vs ${pb.has_more}/${pb.next_height}` : ''}`);
  } else {
    r.match++;
    if (truncated) expected(r, 'paging fields not compared (MongoDB has older blocks)');
    if (keyOrderDiffers(mBlocks, pBlocks)) expected(r, 'key order (jsonb)');
  }
}

async function r5(heights: number[], tip: number, pgMin: number) {
  const r = result('R5 /api/blocks');
  await compareBlocksResponse(r, 'latest 20', '/api/blocks?n=20', pgMin);
  for (const h of heights) {
    await compareBlocksResponse(r, `around ${h}`, `/api/blocks?height=${h}&n=40`, pgMin);
    await compareBlocksResponse(r, `after ${h}`, `/api/blocks?after=${h}&n=10`, pgMin);
    await compareBlocksResponse(r, `before ${h}`, `/api/blocks?before=${h}&n=20`, pgMin);
  }
  await compareBlocksResponse(r, 'after tip', `/api/blocks?after=${tip}&n=10`, pgMin);
}

async function r6(heights: number[]) {
  // By height is covered inside R2 (block_details / previous_block). Here: by hash, plus a hash that doesn't exist.
  const r = result('R6 getBlockByHash');
  const { rows } = await getPgPool().query(
    `SELECT encode(block_hash, 'hex') AS h FROM blocks WHERE height = ANY($1::int[])`, [heights]);
  const hashes = [...rows.map(x => x.h as string), '00'.repeat(32), 'not-hex'];
  for (const hash of hashes) {
    const m = normalizeBlock(JSON.parse(JSON.stringify(await withBackend('mongodb', () => getBlockByHash(hash)))), r);
    const p = normalizeBlock(JSON.parse(JSON.stringify(await withBackend('postgres', () => getBlockByHash(hash)))), r);
    r.checks++;
    const d = diffPaths(m, p);
    if (d.length) mismatch(r, `${hash.slice(0, 16)}…: ${d.join('; ')}`);
    else r.match++;
  }
}

async function r7() {
  const r = result('R7 /api/pools');
  const [m, p] = await Promise.all([
    withBackend('mongodb', async () => (await poolsGET()).json()),
    withBackend('postgres', async () => (await poolsGET()).json()),
  ]) as [Record<string, Json>[], Record<string, Json>[]];
  r.checks++;
  let ok = true;
  if (m.length !== p.length) { ok = false; mismatch(r, `count ${m.length} vs ${p.length}`); }
  const pByName = new Map(p.map(x => [x.name as string, x]));
  for (const mp of m) {
    const pp = pByName.get(mp.name as string);
    if (!pp) { ok = false; mismatch(r, `${mp.name} missing in Postgres`); continue; }
    if (mp.id !== pp.id) expected(r, 'pool id (MongoDB ObjectId vs mining-pools id)');
    const d = diffPaths({ ...mp, id: 0 }, { ...pp, id: 0 });
    if (d.length) { ok = false; mismatch(r, `${mp.name}: ${d.join('; ')}`); }
  }
  if (m.map(x => x.name).join('|') !== p.map(x => x.name).join('|')) expected(r, 'list order differs');
  if (ok) r.match++;
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function parseHeights(arg: string): number[] {
  if (/^\d+-\d+$/.test(arg)) {
    const [a, b] = arg.split('-').map(Number);
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }
  return arg.split(',').map(Number).filter(Number.isInteger);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const pool = getPgPool();

  const { rows: starts } = await pool.query(
    `SELECT s.name, min(x.us) AS start_us, min(x.height) AS first_height FROM (
        SELECT source_id, (extract(epoch FROM received_at) * 1000000)::bigint AS us, height FROM templates
        UNION ALL
        SELECT source_id, (extract(epoch FROM received_at) * 1000000)::bigint, NULL FROM templates_other
     ) x JOIN sources s ON s.id = x.source_id GROUP BY s.name`);
  const ctx: Ctx = {
    pgStart: new Map(starts.map(s => [s.name as string, BigInt(s.start_us)])),
    firstPgHeight: new Map(starts.map(s => [s.name as string, Number(s.first_height)])),
  };
  const { rows: [range] } = await pool.query(
    `SELECT (SELECT min(height) FROM templates) AS tmin, (SELECT max(height) FROM blocks) AS tip,
            (SELECT min(height) FROM blocks) AS bmin`);
  const tip = Number(range.tip), bmin = Number(range.bmin);
  const heights = opt('--heights') ? parseHeights(opt('--heights')!) : parseHeights(`${range.tmin}-${tip + 1}`);
  console.error(`Checking ${heights.length} heights (${heights[0]}…${heights[heights.length - 1]}); tip ${tip}`);

  for (const h of heights) {
    await r1(h, ctx);
    await r2(h, ctx);
    await r4(h, ctx);
  }
  await r3();
  const sample = heights.filter((_, i) => i % 10 === 0);
  await r5(sample, tip, bmin);
  await r6(heights);
  await r7();

  const rows = Object.values(results);
  console.log('| Read | Checks | Match | Mismatch | Expected differences (count) |');
  console.log('|---|---|---|---|---|');
  for (const r of rows) {
    const exp = Object.entries(r.expected).map(([k, v]) => `${k}: ${v}`).join('; ') || '—';
    console.log(`| ${r.read} | ${r.checks} | ${r.match} | ${r.mismatch} | ${exp} |`);
  }
  for (const r of rows.filter(x => x.examples.length)) {
    console.log(`\n${r.read} mismatches (first ${r.examples.length}):`);
    for (const e of r.examples) console.log(`  - ${e}`);
  }
  const json = opt('--json');
  if (json) writeFileSync(json, JSON.stringify({ heights: [heights[0], heights[heights.length - 1]], tip, results: rows }, null, 2));
  await pool.end();
  process.exit(rows.some(r => r.mismatch > 0) ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
