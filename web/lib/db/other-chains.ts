/**
 * Templates that don't build on our Bitcoin chain, for the "Other chains" view, judged at read time from stored facts
 * (docs/design/one-templates-table.md): every template is in `templates`, and nothing stored says which chain it's for.
 * Over the last OTHER_CHAINS_DAYS days of receive time:
 *  - chain 'unknown', reason 'no_bitcoin_parent': its prev_hash is no block we know (bitcoin_parents: blocks and
 *    stale_blocks). Other chains mined on the same connections, mostly; also a Bitcoin template built on a block
 *    the backend hasn't stored yet (seconds, at a new block).
 *  - chain 'btc', reason 'stale_bitcoin_parent': it builds on a Bitcoin block that is stale now (stale_blocks, not
 *    reorged in again).
 * A stuck feed's late re-send of Bitcoin work has a Bitcoin parent, so it isn't here (the height reads leave it out
 * by their receive windows; the template details page shows it). Postgres only: MongoDB mode has no such view.
 *
 * The window is fixed: the anti-join reads every template received in it (the summary takes about 15 s for 90 days on
 * production, all of history about a minute), so the route caches the summary for 30 min.
 *
 * Redundant collection: rows are de-duplicated on the candidates only, as exact copies across a pool's connections:
 * the templates_copies key (height, pool, prev_hash, merkle_branches, version, nbits, ntime) plus the copy number per
 * connection (the k-th such template on each connection matches the k-th on the others). One row per copy group, the
 * first received; `copies` says how many connections had it. No tolerances.
 * POOL_BLACKLIST pools are excluded in SQL (callers pass the names).
 *
 * All SQL is parameterized. Times are returned as ms (summary) or µs (template rows, the page cursor) since the epoch.
 */
import { getPgPool } from './pg';
import type { TemplateRow } from './pg-mapping';

export const OTHER_CHAINS_PAGE_MAX = 200;
export const OTHER_CHAINS_DAYS = 90;
export const OTHER_CHAINS_CHAINS = ['btc', 'unknown'] as const;
export const OTHER_CHAINS_REASONS = ['no_bitcoin_parent', 'stale_bitcoin_parent'] as const;

// The merge-mining (AuxPoW) commitment magic in a coinbase scriptSig. coinbase1 and coinbase2 are checked separately:
// the extranonce sits between them in the real coinbase, so a match across their boundary would be a false one.
const AUXPOW = (alias: string) =>
  `(position('\\xfabe6d6d'::bytea IN ${alias}.coinbase1) > 0 OR position('\\xfabe6d6d'::bytea IN ${alias}.coinbase2) > 0)`;

export interface OtherChainsSummaryRow {
  pool: string;
  chain: string;
  reason: string;
  templates: number;
  min_height: number;
  max_height: number;
  distinct_heights: number;
  distinct_prev_hashes: number;
  first_seen: number;            // ms since the epoch
  last_seen: number;
  auxpow_templates: number;
  auxpow_share: number;          // 0..1
  monthly: number[];             // templates per month, aligned with OtherChainsSummary.months
}

export interface OtherChainsSummary {
  days: number;                  // the receive-time window, in days back from now
  months: string[];              // 'YYYY-MM' (UTC), first to last month with any row, no gaps
  groups: OtherChainsSummaryRow[];
}

interface SummarySqlRow {
  pool: string; chain: string; reason: string; n: string; min_h: number; max_h: number; heights: string;
  prev_hashes: string; first_ms: string; last_ms: string; auxpow: string; monthly: Record<string, string | number>;
}

/**
 * The de-duplicated candidates (alias d), as CTEs. `poolFilter` narrows the templates read (e.g. one pool's name, so
 * only its sources' segments are decompressed); $1 is always the excluded pool names.
 */
function candidates(poolFilter = 'TRUE'): string {
  const window = `t.received_at >= now() - interval '${OTHER_CHAINS_DAYS} days'`;
  return `stale AS (
      SELECT stratum_prev_hash_to_block_hash(block_hash) AS prev_hash FROM stale_blocks WHERE reorged_in_at IS NULL
    ), c AS (
      SELECT t.*, s.name AS pool, 'unknown' AS chain, 'no_bitcoin_parent' AS reason
        FROM templates t JOIN sources s ON s.id = t.source_id
       WHERE ${window} AND s.name <> ALL ($1::text[]) AND ${poolFilter}
         AND NOT EXISTS (SELECT 1 FROM bitcoin_parents p WHERE p.prev_hash = t.prev_hash)
      UNION ALL
      SELECT t.*, s.name AS pool, 'btc' AS chain, 'stale_bitcoin_parent' AS reason
        FROM templates t JOIN sources s ON s.id = t.source_id
       WHERE ${window} AND s.name <> ALL ($1::text[]) AND ${poolFilter}
         AND t.prev_hash IN (SELECT prev_hash FROM stale)
    ), k AS (
      SELECT c.*, row_number() OVER (PARTITION BY c.height, c.pool, c.source_id, c.prev_hash, c.merkle_branches,
                                                  c.version, c.nbits, c.ntime
                                     ORDER BY c.received_at, c.job_id, c.coinbase1, c.coinbase2) AS copy_no
        FROM c
    ), d AS (
      SELECT DISTINCT ON (k.height, k.pool, k.prev_hash, k.merkle_branches, k.version, k.nbits, k.ntime, k.copy_no)
             k.*, count(*) OVER w AS copies
        FROM k
      WINDOW w AS (PARTITION BY k.height, k.pool, k.prev_hash, k.merkle_branches, k.version, k.nbits, k.ntime, k.copy_no)
       ORDER BY k.height, k.pool, k.prev_hash, k.merkle_branches, k.version, k.nbits, k.ntime, k.copy_no,
                k.received_at, k.source_id, k.job_id
    )`;
}

/** Every month from first to last (inclusive), 'YYYY-MM'. */
export function monthRange(first: string, last: string): string[] {
  const out: string[] = [];
  let [y, m] = first.split('-').map(Number);
  const [ly, lm] = last.split('-').map(Number);
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

export function summaryRowsToSummary(rows: SummarySqlRow[]): Omit<OtherChainsSummary, 'days'> {
  const allMonths = rows.flatMap(r => Object.keys(r.monthly ?? {})).sort();
  const months = allMonths.length ? monthRange(allMonths[0], allMonths[allMonths.length - 1]) : [];
  const groups = rows.map(r => {
    const templates = Number(r.n);
    const auxpow = Number(r.auxpow);
    return {
      pool: r.pool, chain: r.chain, reason: r.reason, templates,
      min_height: r.min_h, max_height: r.max_h,
      distinct_heights: Number(r.heights), distinct_prev_hashes: Number(r.prev_hashes),
      first_seen: Number(r.first_ms), last_seen: Number(r.last_ms),
      auxpow_templates: auxpow, auxpow_share: templates ? auxpow / templates : 0,
      monthly: months.map(m => Number(r.monthly?.[m] ?? 0)),
    };
  });
  return { months, groups };
}

/**
 * Per (pool, chain, reason): counts, height range, distinct heights and prev hashes, first / last receive time,
 * AuxPoW share, templates per month. One aggregate over the window's candidates, so callers cache it.
 */
export async function getOtherChainsSummary(excludePools: string[]): Promise<OtherChainsSummary> {
  const { rows } = await getPgPool().query<SummarySqlRow>(
    `WITH ${candidates()}, g AS (
       SELECT pool, chain, reason, count(*) AS n, min(height) AS min_h, max(height) AS max_h,
              count(DISTINCT height) AS heights, count(DISTINCT prev_hash) AS prev_hashes,
              (extract(epoch FROM min(received_at)) * 1000)::bigint AS first_ms,
              (extract(epoch FROM max(received_at)) * 1000)::bigint AS last_ms,
              count(*) FILTER (WHERE ${AUXPOW('d')}) AS auxpow
         FROM d GROUP BY 1, 2, 3
     ), m AS (
       SELECT pool, chain, reason, jsonb_object_agg(month, n) AS monthly
         FROM (SELECT pool, chain, reason,
                      to_char(date_trunc('month', received_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month, count(*) AS n
                 FROM d GROUP BY 1, 2, 3, 4) x
        GROUP BY 1, 2, 3
     )
     SELECT g.*, m.monthly FROM g JOIN m USING (pool, chain, reason)
      ORDER BY g.n DESC, g.pool, g.chain, g.reason`,
    [excludePools],
  );
  return { days: OTHER_CHAINS_DAYS, ...summaryRowsToSummary(rows) };
}

export interface OtherTemplateRow extends TemplateRow {
  chain: string;
  reason: string;
  copies: number;
}

export interface OtherTemplatesPage {
  rows: OtherTemplateRow[];
  next_before: string | null;    // µs cursor for the next (older) page, or null when this was the last
}

export interface OtherTemplatesQuery {
  pool: string;
  chain?: string | null;
  reason?: string | null;
  before?: string | null;        // µs since the epoch (exclusive); null = newest
  n: number;
}

const US = (col: string) => `(extract(epoch FROM ${col}) * 1000000)::bigint`;
const TS = (param: string) => `(timestamptz 'epoch' + ${param}::bigint * interval '1 microsecond')`;

const COLUMNS = `d.source_id, d.pool AS source_name, ${US('d.received_at')} AS received_us, d.height, d.job_id,
  d.prev_hash, d.coinbase1, d.coinbase2, d.merkle_branches, d.version, d.nbits, d.ntime, d.clean_jobs, d.extranonce1,
  d.extranonce2_length, d.latency_ms, d.latency_method::text AS latency_method, d.chain, d.reason,
  d.copies::int AS copies`;
// $1 excluded pools, $2 pool, $3 chain, $4 reason (optional)
const GROUP = `($3::text IS NULL OR d.chain = $3) AND ($4::text IS NULL OR d.reason = $4)`;
const ORDER = `d.received_at DESC, d.source_id DESC, d.job_id DESC`;

/**
 * One page of a group's templates, newest first, keyset-paginated on the receive time (`before`, exclusive). Rows
 * sharing the receive time of the page's last row all go on this page (so the µs cursor never skips a row); such a
 * page can be slightly longer than n.
 */
export async function getOtherTemplates(q: OtherTemplatesQuery, excludePools: string[]): Promise<OtherTemplatesPage> {
  const n = Math.min(Math.max(1, Math.floor(q.n)), OTHER_CHAINS_PAGE_MAX);
  if (excludePools.includes(q.pool)) return { rows: [], next_before: null };
  const pool = getPgPool();
  const base = [excludePools, q.pool, q.chain ?? null, q.reason ?? null];
  // The pool's source ids as values, not a join on sources.name: source_id is the columnstore segment key, so only
  // that pool's segments are decompressed (production: 3.3 s instead of 13 s for a pool's 90 days).
  const ids = (await pool.query<{ id: number }>(`SELECT id FROM sources WHERE name = $1`, [q.pool])).rows.map(r => r.id);
  if (ids.length === 0) return { rows: [], next_before: null };
  const page = (await pool.query<OtherTemplateRow>(
    `WITH ${candidates('t.source_id = ANY ($7::int[]) AND s.name = $2')} SELECT ${COLUMNS} FROM d
      WHERE ${GROUP} AND ($5::bigint IS NULL OR d.received_at < ${TS('$5')})
      ORDER BY ${ORDER} LIMIT $6`, [...base, q.before ?? null, n + 1, ids])).rows;
  return finishPage(page, n, async us => (await pool.query<OtherTemplateRow>(
    `WITH ${candidates('t.source_id = ANY ($6::int[]) AND s.name = $2')} SELECT ${COLUMNS} FROM d
      WHERE ${GROUP} AND d.received_at = ${TS('$5')}
      ORDER BY ${ORDER}`, [...base, us, ids])).rows);
}

/** Cut a page fetched with LIMIT n + 1; rows tied with the last row's receive time are all included. */
async function finishPage(
  rows: OtherTemplateRow[], n: number, tiedAt: (us: string) => Promise<OtherTemplateRow[]>,
): Promise<OtherTemplatesPage> {
  if (rows.length <= n) return { rows, next_before: null };
  const last = rows[n - 1].received_us;
  if (rows[n].received_us !== last) return { rows: rows.slice(0, n), next_before: String(last) };
  const before = rows.slice(0, n).filter(r => r.received_us !== last);
  return { rows: [...before, ...(await tiedAt(last))], next_before: String(last) };
}
