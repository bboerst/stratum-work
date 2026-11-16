/**
 * Templates that aren't Bitcoin's (`templates_other`: other chains mined on the same connections, implausible
 * heights, unknown chains, BIP34 parse failures), for the "Other chains" view. Postgres only: MongoDB mode mixes them
 * into mining_notify without a classification.
 *
 * Redundant collection: like the other template reads (lib/db/postgres.ts), rows come from the one-stream-per-pool
 * view `templates_other_dedup` (db/migrations/20261116200001_one_stream_per_pool.sql) so a pool collected over several
 * connections isn't counted twice. That view needs a height filter to be cheap (its windows partition by height and
 * pool), and both reads here span all heights, so:
 *  - Pools with ONE source read `templates_other` directly. The migration guarantees the view returns exactly the raw
 *    rows for them, so this is the same result without the view's sorts (most pools, most rows).
 *  - Pools with several sources read the view, filtered on those pool names (pushed down through the windows).
 * POOL_BLACKLIST pools are excluded in SQL from both reads, at every height (callers pass the names).
 *
 * All SQL is parameterized. Times are returned as ms (summary) or µs (template rows, the page cursor) since the epoch.
 */
import { getPgPool } from './pg';
import type { TemplateRow } from './pg-mapping';

export const OTHER_CHAINS_PAGE_MAX = 200;
export const OTHER_CHAINS_CHAINS = ['btc', 'bch', 'unknown'] as const;

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
  months: string[];              // 'YYYY-MM' (UTC), first to last month with any row, no gaps
  groups: OtherChainsSummaryRow[];
}

interface SummarySqlRow {
  pool: string; chain: string; reason: string; n: string; min_h: number; max_h: number; heights: string;
  prev_hashes: string; first_ms: string; last_ms: string; auxpow: string; monthly: Record<string, string | number>;
}

/** Pool names (sources.name) collected over more than one source (replicas, sites). */
async function multiSourcePools(): Promise<string[]> {
  const { rows } = await getPgPool().query<{ name: string }>(
    `SELECT name FROM sources GROUP BY name HAVING count(*) > 1 ORDER BY name`);
  return rows.map(r => r.name);
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

export function summaryRowsToSummary(rows: SummarySqlRow[]): OtherChainsSummary {
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
 * AuxPoW share, templates per month. One aggregate query over every row (the view's cost for multi-source pools is
 * a sort of their rows; see the module comment), so callers cache it.
 */
export async function getOtherChainsSummary(excludePools: string[]): Promise<OtherChainsSummary> {
  const multi = (await multiSourcePools()).filter(p => !excludePools.includes(p));
  const { rows } = await getPgPool().query<SummarySqlRow>(
    `WITH d AS MATERIALIZED (
       SELECT s.name AS pool, t.chain, t.reason, t.height, t.prev_hash, t.received_at, ${AUXPOW('t')} AS auxpow
         FROM templates_other t JOIN sources s ON s.id = t.source_id
        WHERE s.name <> ALL ($1::text[]) AND s.name <> ALL ($2::text[])
       UNION ALL
       SELECT j.pool, j.chain, j.reason, j.height, j.prev_hash, j.received_at, ${AUXPOW('j')}
         FROM templates_other_dedup j
        WHERE j.pool = ANY ($2::text[])
     ), g AS (
       SELECT pool, chain::text AS chain, reason, count(*) AS n, min(height) AS min_h, max(height) AS max_h,
              count(DISTINCT height) AS heights, count(DISTINCT prev_hash) AS prev_hashes,
              (extract(epoch FROM min(received_at)) * 1000)::bigint AS first_ms,
              (extract(epoch FROM max(received_at)) * 1000)::bigint AS last_ms,
              count(*) FILTER (WHERE auxpow) AS auxpow
         FROM d GROUP BY 1, 2, 3
     ), m AS (
       SELECT pool, chain, reason, jsonb_object_agg(month, n) AS monthly
         FROM (SELECT pool, chain::text AS chain, reason,
                      to_char(date_trunc('month', received_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month, count(*) AS n
                 FROM d GROUP BY 1, 2, 3, 4) x
        GROUP BY 1, 2, 3
     )
     SELECT g.*, m.monthly FROM g JOIN m USING (pool, chain, reason)
      ORDER BY g.n DESC, g.pool, g.chain, g.reason`,
    [excludePools, multi],
  );
  return summaryRowsToSummary(rows);
}

export interface OtherTemplateRow extends TemplateRow {
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

const RAW_COLUMNS = `t.source_id, s.name AS source_name, ${US('t.received_at')} AS received_us, t.height, t.job_id,
  t.prev_hash, t.coinbase1, t.coinbase2, t.merkle_branches, t.version, t.nbits, t.ntime, t.clean_jobs, t.extranonce1,
  t.extranonce2_length, t.latency_ms, t.latency_method::text AS latency_method, t.chain::text AS chain, t.reason,
  1 AS copies`;
const DEDUP_COLUMNS = `j.source_id, j.pool AS source_name, ${US('j.received_at')} AS received_us,
  ${US('j.first_seen')} AS first_seen_us, j.height, j.job_id, j.prev_hash, j.coinbase1, j.coinbase2,
  j.merkle_branches, j.version, j.nbits, j.ntime, j.clean_jobs, j.extranonce1, j.extranonce2_length, j.latency_ms,
  j.latency_method::text AS latency_method, j.chain::text AS chain, j.reason, j.copies::int AS copies`;

// Optional group filters, the same on the table (t) and the view (j). $1 pool, $2 chain, $3 reason.
const GROUP = (a: string, pool: string) =>
  `${pool} = $1 AND ($2::text IS NULL OR ${a}.chain::text = $2) AND ($3::text IS NULL OR ${a}.reason = $3)`;
const ORDER = (a: string) => `${a}.received_at DESC, ${a}.source_id DESC, ${a}.job_id DESC`;

/** At most this many raw rows are looked at to find one page of a multi-source pool (it stops much earlier). */
const CANDIDATES_MAX = 50_000;

/**
 * One page of a group's templates, newest first, keyset-paginated on the receive time (`before`, exclusive). Rows
 * sharing the receive time of the page's last row all go on this page (so the µs cursor never skips a row); such a
 * page can be slightly longer than n.
 */
export async function getOtherTemplates(q: OtherTemplatesQuery, excludePools: string[]): Promise<OtherTemplatesPage> {
  const n = Math.min(Math.max(1, Math.floor(q.n)), OTHER_CHAINS_PAGE_MAX);
  if (excludePools.includes(q.pool)) return { rows: [], next_before: null };
  const pool = getPgPool();
  const base = [q.pool, q.chain ?? null, q.reason ?? null];
  const before = q.before ?? null;
  const sources = Number((await pool.query<{ c: string }>(
    `SELECT count(*) AS c FROM sources WHERE name = $1`, [q.pool])).rows[0].c);

  if (sources <= 1) {
    // One source: the raw rows are the de-duplicated rows.
    const page = (await pool.query<OtherTemplateRow>(
      `SELECT ${RAW_COLUMNS} FROM templates_other t JOIN sources s ON s.id = t.source_id
        WHERE ${GROUP('t', 's.name')} AND ($4::bigint IS NULL OR t.received_at < ${TS('$4')})
        ORDER BY ${ORDER('t')} LIMIT $5`, [...base, before, n + 1])).rows;
    return finishPage(page, n, async us => (await pool.query<OtherTemplateRow>(
      `SELECT ${RAW_COLUMNS} FROM templates_other t JOIN sources s ON s.id = t.source_id
        WHERE ${GROUP('t', 's.name')} AND t.received_at = ${TS('$4')}
        ORDER BY ${ORDER('t')}`, [...base, us])).rows);
  }

  // Several sources: the view, at the heights of the newest raw rows before the cursor. Every shown row is a raw row,
  // so the shown rows received after the oldest candidate (`lower`, exclusive) are all at candidate heights; if fewer
  // than a page, look at more candidates.
  for (let limit = 4 * (n + 1); ; limit *= 4) {
    const cand = (await pool.query<{ height: number; us: string }>(
      `SELECT t.height, ${US('t.received_at')} AS us FROM templates_other t JOIN sources s ON s.id = t.source_id
        WHERE ${GROUP('t', 's.name')} AND ($4::bigint IS NULL OR t.received_at < ${TS('$4')})
        ORDER BY t.received_at DESC LIMIT $5`, [...base, before, limit])).rows;
    const complete = cand.length < limit;           // every raw row before the cursor is a candidate
    const lower = complete ? null : cand[cand.length - 1].us;
    const heights = [...new Set(cand.map(c => c.height))];
    const page = (await pool.query<OtherTemplateRow>(
      `SELECT ${DEDUP_COLUMNS} FROM templates_other_dedup j
        WHERE ${GROUP('j', 'j.pool')} AND j.height = ANY ($6::int[])
          AND ($4::bigint IS NULL OR j.received_at < ${TS('$4')}) AND ($7::bigint IS NULL OR j.received_at > ${TS('$7')})
        ORDER BY ${ORDER('j')} LIMIT $5`, [...base, before, n + 1, heights, lower])).rows;
    if (page.length > n || complete) {
      return finishPage(page, n, async us => (await pool.query<OtherTemplateRow>(
        `SELECT ${DEDUP_COLUMNS} FROM templates_other_dedup j
          WHERE ${GROUP('j', 'j.pool')} AND j.height = ANY ($5::int[]) AND j.received_at = ${TS('$4')}
          ORDER BY ${ORDER('j')}`, [...base, us, heights])).rows);
    }
    if (limit >= CANDIDATES_MAX) {
      // Mostly hidden rows (another connection's stream): return what was found; the next page starts at `lower`.
      return { rows: page, next_before: String(BigInt(lower!) + BigInt(1)) };
    }
  }
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
