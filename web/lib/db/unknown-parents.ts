/**
 * Unknown parents (/unknown-parents), read at read time from stored facts (docs/design/one-templates-table.md): templates
 * of the last UNKNOWN_PARENTS_DAYS days whose prev_hash is no block we know (bitcoin_parents: blocks and stale_blocks),
 * grouped by that parent into EPISODES. An unknown parent is another chain mined on the same connection, a Bitcoin
 * block we never recorded (a lost race, a pool's own block that lost), or not a valid block at all; which one is
 * inferred from the facts returned here (lib/parentKind.ts), never stored.
 *
 * Work on a stale Bitcoin block we recorded is Bitcoin work: the stale-blocks / fork view shows it (stale_tip_templates()).
 * A stuck feed's late re-send of Bitcoin work has a Bitcoin parent, so it isn't here either.
 *
 * The summary per (parent, pool) is read from unknown_parent_pools (getEpisodePoolRows), counted facts the backend keeps
 * up to date (backend/unknown_parents.py: after each block, plus a backfill), for a range of 90 days, a year or all
 * history; "still unknown" is judged here, at read time, against bitcoin_parents. Until that table is filled, 90 days
 * fall back to the live read of templates (getLiveEpisodePoolRows: a narrow anti-join finds where the candidates are,
 * then a wide read fetches only those, aggregated per (parent, pool), the same aggregation the backend stores). The
 * per-episode facts (tip, Bitcoin bits) are looked up on the aggregated episodes only, by height through
 * blocks_height. The drill-in reads one episode's pools at heights h - 1 .. h + 1 within its receive times (± a
 * margin): bounded by source, height and time.
 *
 * Redundant collection: rows are de-duplicated as exact copies across a pool's connections: the templates_copies key
 * (height, pool, prev_hash, merkle_branches, version, nbits, ntime) plus the copy number per connection (the k-th such
 * template on each connection matches the k-th on the others). One row per copy group, the first received; `copies`
 * says how many connections had it. No tolerances.
 *
 * Connections are labelled a, b, … per pool: the pool's sources ranked by (site, replica) in "C" collation, the
 * order the de-duplicated reads rank them in (templates_copies' source_rank), over all of the pool's sources, so a
 * letter names the same connection in every episode. Site and replica names are never returned.
 *
 * POOL_BLACKLIST pools are excluded in SQL everywhere (callers pass the names): they add no templates, pools or
 * connections, and an episode only they built on doesn't exist here. All SQL is parameterized. Times are ms (summary)
 * or µs (template rows) since the epoch.
 */
import { getPgPool } from './pg';
import type { TemplateRow } from './pg-mapping';

export const UNKNOWN_PARENTS_DAYS = 90;            // the live fallback's window, and the default range

/** The page's ranges: the episodes whose last template is within the last 90 or 365 days, or all of them. */
export const UNKNOWN_PARENTS_RANGES = ['90d', '1y', 'all'] as const;
export type UnknownParentsRange = typeof UNKNOWN_PARENTS_RANGES[number];
export const RANGE_DAYS: Record<UnknownParentsRange, number | null> = { '90d': UNKNOWN_PARENTS_DAYS, '1y': 365, all: null };
export const DRILL_MARGIN_MS = 5 * 60_000;      // receive-time margin around an episode in the drill-in
export const DRILL_MAX_TEMPLATES = 5000;

// The merge-mining (AuxPoW) commitment magic in a coinbase scriptSig. coinbase1 and coinbase2 are checked separately:
// the extranonce sits between them in the real coinbase, so a match across their boundary would be a false one.
const AUXPOW = (alias: string) =>
  `(position('\\xfabe6d6d'::bytea IN ${alias}.coinbase1) > 0 OR position('\\xfabe6d6d'::bytea IN ${alias}.coinbase2) > 0)`;

/**
 * Sources of the pools not excluded ($1), with each one's connection rank (1 = 'a') within its pool.
 */
const SOURCES = `src AS (
      SELECT id, name, dense_rank() OVER (PARTITION BY name ORDER BY site COLLATE "C", replica COLLATE "C")::int AS conn
        FROM sources WHERE name <> ALL ($1::text[])
    )`;

/**
 * Exact-copy de-duplication of `c` (templates joined with src as pool / conn) into k (with copy_no) and d (one row per
 * copy group, the first received, with `copies` and `conns`: the connection ranks that had it).
 */
function dedup(cBody: string): string {
  return `${SOURCES}, c AS (${cBody}), k AS (
      SELECT c.*, row_number() OVER (PARTITION BY c.height, c.pool, c.source_id, c.prev_hash, c.merkle_branches,
                                                  c.version, c.nbits, c.ntime
                                     ORDER BY c.received_at, c.job_id, c.coinbase1, c.coinbase2) AS copy_no
        FROM c
    ), d AS (
      SELECT DISTINCT ON (k.height, k.pool, k.prev_hash, k.merkle_branches, k.version, k.nbits, k.ntime, k.copy_no)
             k.*, count(*) OVER w AS copies, array_agg(k.conn) OVER w AS conns
        FROM k
      WINDOW w AS (PARTITION BY k.height, k.pool, k.prev_hash, k.merkle_branches, k.version, k.nbits, k.ntime, k.copy_no)
       ORDER BY k.height, k.pool, k.prev_hash, k.merkle_branches, k.version, k.nbits, k.ntime, k.copy_no,
                k.received_at, k.source_id, k.job_id
    )`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Summary: episodes

/** One pool's part of an episode. */
export interface EpisodePoolSql {
  parent: string;                       // display-order hex of the unknown parent
  pool: string;
  n: string;                            // templates (de-duplicated)
  first_ms: string;
  last_ms: string;
  auxpow: string;
  conns: number[];                      // connection ranks that received templates on this parent
  heights: Record<string, string | number>;   // height -> templates
  nbits: Record<string, string | number>;     // nbits -> templates
}

const ANTI_JOIN = `NOT EXISTS (SELECT 1 FROM bitcoin_parents p WHERE p.prev_hash = t.prev_hash)`;

/**
 * The rows per (unknown parent, pool) of the range, from unknown_parent_pools: every pool's row of each parent that is
 * no block we know now (bitcoin_parents) and whose last template (over the pools not excluded) is in the range. A
 * stored row covers all of the parent's templates, so an episode that began before the range is shown whole. Same
 * shape and order as the live read. Until the backend has filled the table, 90 days are read live.
 */
export async function getEpisodePoolRows(excludePools: string[], range: UnknownParentsRange = '90d'): Promise<EpisodePoolSql[]> {
  const pool = getPgPool();
  const days = RANGE_DAYS[range];
  if (range === '90d') {
    const { rows } = await pool.query<{ filled: boolean }>(`SELECT EXISTS (SELECT 1 FROM unknown_parent_pools) AS filled`);
    if (!rows[0]?.filled) return getLiveEpisodePoolRows(excludePools);
  }
  const since = days === null ? null : new Date(Date.now() - days * 86_400_000).toISOString();
  const { rows } = await pool.query<EpisodePoolSql>(
    `WITH u AS (
       SELECT u.*, max(u.last_received) OVER (PARTITION BY u.prev_hash) AS parent_last
         FROM unknown_parent_pools u
        WHERE u.pool <> ALL ($1::text[]) AND NOT EXISTS (SELECT 1 FROM bitcoin_parents p WHERE p.prev_hash = u.prev_hash)
     )
     SELECT encode(stratum_prev_hash_to_block_hash(u.prev_hash), 'hex') AS parent, u.pool, u.n::bigint AS n,
            (extract(epoch FROM u.first_received) * 1000)::bigint AS first_ms,
            (extract(epoch FROM u.last_received) * 1000)::bigint AS last_ms,
            u.auxpow::bigint AS auxpow, u.conns, u.heights, u.nbits
       FROM u
      WHERE $2::timestamptz IS NULL OR u.parent_last >= $2::timestamptz
      ORDER BY first_ms, parent, u.pool`,
    [excludePools, since],
  );
  return rows;
}

/**
 * The rows per (unknown parent, pool) of the last UNKNOWN_PARENTS_DAYS days, read live, in two reads of templates:
 *  1. narrow: the (height, source_id) pairs with candidates, and their receive-time range. It reads only received_at,
 *     source_id, height and prev_hash, so it runs in parallel and decompresses little (one wide read of every column
 *     of every row in the window ran serially and took about 30 s on production; this one takes a second or two);
 *  2. wide: every column of the candidates, restricted to those pairs and that time range, passed as values, so
 *     TimescaleDB skips chunks and compressed batches by their source_id segment and height / received_at metadata.
 *     The window and the anti-join are applied again, so the candidates are exactly those of a single read.
 * The window starts at the same instant in both reads (`since`).
 */
export async function getLiveEpisodePoolRows(excludePools: string[]): Promise<EpisodePoolSql[]> {
  const pool = getPgPool();
  const since = new Date(Date.now() - UNKNOWN_PARENTS_DAYS * 86_400_000).toISOString();
  const excludedIds = excludePools.length === 0 ? [] : (await pool.query<{ id: number }>(
    `SELECT id FROM sources WHERE name = ANY ($1::text[])`, [excludePools])).rows.map(r => r.id);
  // the receive-time range over all pairs as text (exact to the µs; a JS Date would round to ms)
  const pairs = (await pool.query<{ height: number; source_id: number; t_from: string; t_to: string }>(
    `SELECT t.height, t.source_id,
            (min(min(t.received_at)) OVER ())::text AS t_from, (max(max(t.received_at)) OVER ())::text AS t_to
       FROM templates t
      WHERE t.received_at >= $1::timestamptz AND t.source_id <> ALL ($2::int[]) AND ${ANTI_JOIN}
      GROUP BY 1, 2`, [since, excludedIds])).rows;
  if (pairs.length === 0) return [];
  const heights = pairs.map(p => p.height), sourceIds = pairs.map(p => p.source_id);
  const { rows } = await pool.query<EpisodePoolSql>(
    `WITH q AS (SELECT DISTINCT * FROM unnest($3::int[], $4::int[]) AS q(height, source_id)),
     ${dedup(`SELECT t.*, s.name AS pool, s.conn FROM templates t JOIN src s ON s.id = t.source_id
                    JOIN q ON q.height = t.height AND q.source_id = t.source_id
                    WHERE t.received_at >= $5::timestamptz AND t.received_at <= $6::timestamptz
                      AND t.source_id = ANY ($4::int[]) AND t.height = ANY ($3::int[])
                      AND t.received_at >= $2::timestamptz AND ${ANTI_JOIN}`)},
     g AS (
       SELECT prev_hash, pool, count(*) AS n,
              (extract(epoch FROM min(received_at)) * 1000)::bigint AS first_ms,
              (extract(epoch FROM max(received_at)) * 1000)::bigint AS last_ms,
              count(*) FILTER (WHERE ${AUXPOW('d')}) AS auxpow
         FROM d GROUP BY 1, 2
     ), hc AS (
       SELECT prev_hash, pool, jsonb_object_agg(height, n) AS heights
         FROM (SELECT prev_hash, pool, height, count(*) AS n FROM d GROUP BY 1, 2, 3) x GROUP BY 1, 2
     ), nc AS (
       SELECT prev_hash, pool, jsonb_object_agg(nbits, n) AS nbits
         FROM (SELECT prev_hash, pool, nbits, count(*) AS n FROM d GROUP BY 1, 2, 3) x GROUP BY 1, 2
     ), cc AS (
       SELECT prev_hash, pool, array_agg(DISTINCT conn ORDER BY conn) AS conns FROM k GROUP BY 1, 2
     )
     SELECT encode(stratum_prev_hash_to_block_hash(g.prev_hash), 'hex') AS parent, g.pool, g.n, g.first_ms, g.last_ms,
            g.auxpow, cc.conns, hc.heights, nc.nbits
       FROM g JOIN hc USING (prev_hash, pool) JOIN nc USING (prev_hash, pool) JOIN cc USING (prev_hash, pool)
      ORDER BY g.first_ms, parent, g.pool`,
    [excludePools, since, heights, sourceIds, pairs[0].t_from, pairs[0].t_to],
  );
  return rows;
}

export interface EpisodeFactsQuery {
  parent: string;                       // display hex
  height: number;
  first_ms: number;
}

export interface EpisodeFactsSql {
  i: number;
  tip: number | null;                   // best-chain tip when the first template arrived
  bits_prev: string | null;             // bits of the best block at h - 1 (NULL bits count as no block)
  bits_at: string | null;               // ... at h
  in_stale: boolean;                    // the parent is in stale_blocks
}

/**
 * Per episode: the tip at its first template (the highest best-chain block whose arrival, coalesce(seen_at,
 * block_time), is at or before it: walks blocks_height from the top), Bitcoin's bits at h - 1 and h (the earliest
 * arrival when a height has two best rows), and whether the parent is a recorded stale block. With the summary's
 * candidates that last one is false by construction (bitcoin_parents includes stale_blocks); it is read, not assumed,
 * so the badge stays true if the candidate rule changes.
 */
export async function getEpisodeFacts(eps: EpisodeFactsQuery[]): Promise<EpisodeFactsSql[]> {
  if (eps.length === 0) return [];
  const bits = (h: string) => `(SELECT b.bits FROM blocks_best b WHERE b.height = ${h} AND b.bits IS NOT NULL
                                 ORDER BY coalesce(b.seen_at, b.block_time), b.block_hash LIMIT 1)::text`;
  const { rows } = await getPgPool().query<EpisodeFactsSql>(
    `SELECT e.i::int AS i,
            (SELECT b.height FROM blocks_best b
              WHERE coalesce(b.seen_at, b.block_time) <= timestamptz 'epoch' + e.first_ms * interval '1 millisecond'
              ORDER BY b.height DESC LIMIT 1) AS tip,
            ${bits('e.h - 1')} AS bits_prev, ${bits('e.h')} AS bits_at,
            EXISTS (SELECT 1 FROM stale_blocks s WHERE s.block_hash = decode(e.parent, 'hex')) AS in_stale
       FROM unnest($1::text[], $2::int[], $3::bigint[]) WITH ORDINALITY AS e(parent, h, first_ms, i)
      ORDER BY e.i`,
    [eps.map(e => e.parent), eps.map(e => e.height), eps.map(e => e.first_ms)],
  );
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------------
// Drill-in

export type ParentLabel = 'best' | 'stale' | 'this' | 'other';

export interface DrillTemplateRow extends TemplateRow {
  copies: number;
  conns: number[];
  parent_label: ParentLabel;
}

export interface DrillBlockRow {
  block_hash: string;                   // display hex
  height: number;
  arrival_ms: string;                   // coalesce(seen_at, block_time); a stale-only block: first_seen
  best: boolean;
}

export interface DrillQuery {
  parent: string;                       // display hex of the episode's parent
  height: number;
  pools: string[];
  from_ms: number;
  to_ms: number;
}

export interface DrillRows {
  templates: DrillTemplateRow[];
  truncated: boolean;
  blocks: DrillBlockRow[];
}

const US = (col: string) => `(extract(epoch FROM ${col}) * 1000000)::bigint`;

/**
 * Every template from the episode's pools at heights h - 1 .. h + 1 received in [from, to], de-duplicated like the
 * summary, each labelled by the parent it built on: 'this' (the episode's parent), 'best' (a best-chain block), 'stale'
 * (a block we know that isn't on the best chain) or 'other' (another unknown parent). Plus every block we know at
 * h - 1 and h, with its arrival. Bounded: source ids as values (columnstore segments), height and time ranges, a row cap.
 */
export async function getDrillRows(q: DrillQuery, excludePools: string[]): Promise<DrillRows> {
  const pool = getPgPool();
  const pools = q.pools.filter(p => !excludePools.includes(p));
  const ids = pools.length === 0 ? [] : (await pool.query<{ id: number }>(
    `SELECT id FROM sources WHERE name = ANY ($1::text[]) AND name <> ALL ($2::text[])`, [pools, excludePools])).rows.map(r => r.id);
  const ms = (p: string) => `(timestamptz 'epoch' + ${p}::bigint * interval '1 millisecond')`;
  const templates = ids.length === 0 ? [] : (await pool.query<DrillTemplateRow>(
    `WITH ${dedup(`SELECT t.*, s.name AS pool, s.conn FROM templates t JOIN src s ON s.id = t.source_id
                    WHERE t.source_id = ANY ($2::int[]) AND t.height BETWEEN $3::int - 1 AND $3::int + 1
                      AND t.received_at >= ${ms('$4')} AND t.received_at <= ${ms('$5')}`)}
     SELECT d.source_id, d.pool AS source_name, ${US('d.received_at')} AS received_us, d.height, d.job_id, d.prev_hash,
            d.coinbase1, d.coinbase2, d.merkle_branches, d.version, d.nbits, d.ntime, d.clean_jobs, d.extranonce1,
            d.extranonce2_length, d.latency_ms, d.latency_method::text AS latency_method, d.copies::int AS copies,
            ARRAY(SELECT DISTINCT x FROM unnest(d.conns) x ORDER BY x) AS conns,
            CASE WHEN d.prev_hash = stratum_prev_hash_to_block_hash(decode($6, 'hex')) THEN 'this'
                 WHEN EXISTS (SELECT 1 FROM blocks_best b WHERE b.block_hash = stratum_prev_hash_to_block_hash(d.prev_hash)) THEN 'best'
                 WHEN EXISTS (SELECT 1 FROM bitcoin_parents p WHERE p.prev_hash = d.prev_hash) THEN 'stale'
                 ELSE 'other' END AS parent_label
       FROM d ORDER BY d.received_at, d.pool, d.job_id LIMIT $7`,
    [excludePools, ids, q.height, q.from_ms, q.to_ms, q.parent, DRILL_MAX_TEMPLATES + 1])).rows;
  const blocks = (await pool.query<DrillBlockRow>(
    `SELECT encode(b.block_hash, 'hex') AS block_hash, b.height,
            (extract(epoch FROM coalesce(b.seen_at, b.block_time)) * 1000)::bigint AS arrival_ms,
            EXISTS (SELECT 1 FROM blocks_best bb WHERE bb.block_hash = b.block_hash) AS best
       FROM blocks b WHERE b.height BETWEEN $1::int - 1 AND $1::int
     UNION ALL
     SELECT encode(s.block_hash, 'hex'), s.height, (extract(epoch FROM s.first_seen) * 1000)::bigint, false
       FROM stale_blocks s
      WHERE s.height BETWEEN $1::int - 1 AND $1::int AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.block_hash = s.block_hash)
      ORDER BY 2, 3`,
    [q.height])).rows;
  return { templates: templates.slice(0, DRILL_MAX_TEMPLATES), truncated: templates.length > DRILL_MAX_TEMPLATES, blocks };
}
