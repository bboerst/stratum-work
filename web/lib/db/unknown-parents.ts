/**
 * Unknown parents (the Forks page, /forks), read at read time from stored facts (docs/design/one-templates-table.md): templates
 * of the last UNKNOWN_PARENTS_DAYS days whose prev_hash is no block we know (bitcoin_parents: blocks and stale_blocks),
 * grouped by that parent into EPISODES. An unknown parent is another chain mined on the same connection, a Bitcoin
 * block we never recorded (a lost race, a pool's own block that lost), or not a valid block at all; which one is
 * inferred from the facts returned here (lib/parentKind.ts), never stored.
 *
 * Work on a stale Bitcoin block we recorded isn't an unknown parent: the Forks page reads it from the backend's twin
 * summary, stale_parent_pools (getStaleEpisodePoolRows, below). A stuck feed's late re-send of Bitcoin work has a
 * Bitcoin parent, so it isn't here.
 *
 * The summary per (parent, pool) is read from unknown_parent_pools (getEpisodePoolRows), counted facts the backend keeps
 * up to date (backend/unknown_parents.py: after each block, plus a backfill), for a range in Bitcoin time: the last 6
 * or 26 difficulty epochs (12,096 or 52,416 blocks) or all history; "still unknown" is judged here, at read time,
 * against bitcoin_parents. Until that table is filled, the default range falls back to the live read of templates
 * (getLiveEpisodePoolRows, over the last 90 days: a narrow anti-join finds where the candidates are,
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

export const UNKNOWN_PARENTS_DAYS = 90;            // the live fallback's window (wall-clock: it reads templates by time)
export const EPOCH_BLOCKS = 2016;                  // a difficulty epoch

/**
 * The page's ranges, in Bitcoin time: the episodes whose last template arrived after the best-chain block 6 or 26
 * epochs below our tip did, or all of them.
 */
export const UNKNOWN_PARENTS_RANGES = ['6e', '26e', 'all'] as const;
export type UnknownParentsRange = typeof UNKNOWN_PARENTS_RANGES[number];
export const DEFAULT_RANGE: UnknownParentsRange = '6e';
export const RANGE_BLOCKS: Record<UnknownParentsRange, number | null> = { '6e': 6 * EPOCH_BLOCKS, '26e': 26 * EPOCH_BLOCKS, all: null };
/** Earlier, wall-clock range values, still accepted (shared links) and read as their nearest range. */
export const LEGACY_RANGES: Record<string, UnknownParentsRange> = { '90d': '6e', '1y': '26e' };
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
 * copy group, the first received, with `copies` and `conns`: the connection ranks that had it). `coinbase: false` for a
 * `c` without the coinbase columns: they only break ties between rows received at the same instant with the same job
 * id, which changes no count, first or last time.
 */
function dedup(cBody: string, { coinbase = true } = {}): string {
  return `${SOURCES}, c AS (${cBody}), k AS (
      SELECT c.*, row_number() OVER (PARTITION BY c.height, c.pool, c.source_id, c.prev_hash, c.merkle_branches,
                                                  c.version, c.nbits, c.ntime
                                     ORDER BY c.received_at, c.job_id${coinbase ? ', c.coinbase1, c.coinbase2' : ''}) AS copy_no
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
  auxpow: string | null;                // NULL: not counted (stale parents)
  conns: number[];                      // connection ranks that received templates on this parent
  heights: Record<string, string | number>;   // height -> templates
  nbits: Record<string, string | number>;     // nbits -> templates
}

const ANTI_JOIN = `NOT EXISTS (SELECT 1 FROM bitcoin_parents p WHERE p.prev_hash = t.prev_hash)`;

/**
 * The rows per (unknown parent, pool) of the range, from unknown_parent_pools: every pool's row of each parent that is
 * no block we know now (bitcoin_parents) and whose last template (over the pools not excluded) arrived at or after the
 * best-chain block at height tip - N did (coalesce(seen_at, block_time); tip: the highest best-chain block; no such
 * block, or all history: no cutoff). A stored row covers all of the parent's templates, so an episode that began
 * before the range is shown whole. Same shape and order as the live read. Until the backend has filled the table, the
 * default range is read live (over the last UNKNOWN_PARENTS_DAYS days: the live read selects templates by receive time).
 */
export async function getEpisodePoolRows(excludePools: string[], range: UnknownParentsRange = DEFAULT_RANGE): Promise<EpisodePoolSql[]> {
  const pool = getPgPool();
  if (range === DEFAULT_RANGE) {
    const { rows } = await pool.query<{ filled: boolean }>(`SELECT EXISTS (SELECT 1 FROM unknown_parent_pools) AS filled`);
    if (!rows[0]?.filled) return getLiveEpisodePoolRows(excludePools);
  }
  const { rows } = await pool.query<EpisodePoolSql>(
    `WITH cut AS (
       SELECT coalesce((SELECT coalesce(b.seen_at, b.block_time) FROM blocks_best b
                         WHERE $2::int IS NOT NULL AND b.height <= (SELECT max(height) FROM blocks_best) - $2::int
                         ORDER BY b.height DESC, coalesce(b.seen_at, b.block_time) LIMIT 1),
                       '-infinity'::timestamptz) AS at
     ), u AS (
       SELECT u.*, max(u.last_received) OVER (PARTITION BY u.prev_hash) AS parent_last
         FROM unknown_parent_pools u
        WHERE u.pool <> ALL ($1::text[]) AND NOT EXISTS (SELECT 1 FROM bitcoin_parents p WHERE p.prev_hash = u.prev_hash)
     )
     SELECT encode(stratum_prev_hash_to_block_hash(u.prev_hash), 'hex') AS parent, u.pool, u.n::bigint AS n,
            (extract(epoch FROM u.first_received) * 1000)::bigint AS first_ms,
            (extract(epoch FROM u.last_received) * 1000)::bigint AS last_ms,
            u.auxpow::bigint AS auxpow, u.conns, u.heights, u.nbits
       FROM u, cut
      WHERE u.parent_last >= cut.at
      ORDER BY first_ms, parent, u.pool`,
    [excludePools, RANGE_BLOCKS[range]],
  );
  return rows;
}

/** Our Bitcoin tip: the highest best-chain block (null with no blocks). */
export async function getBestTipHeight(): Promise<number | null> {
  const { rows } = await getPgPool().query<{ tip: number | null }>(`SELECT max(height) AS tip FROM blocks_best`);
  return rows[0]?.tip ?? null;
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
     ${aggregate()}`,
    [excludePools, since, heights, sourceIds, pairs[0].t_from, pairs[0].t_to],
  );
  return rows;
}

/**
 * The rows per (parent, pool) from the de-duplicated `d` / `k` (dedup()): the summary's aggregation, the backend's for
 * unknown_parent_pools. `auxpow: false` for a `d` read without the coinbase columns: the AuxPoW count is then NULL.
 */
function aggregate({ auxpow = true } = {}): string {
  return `g AS (
       SELECT prev_hash, pool, count(*) AS n,
              (extract(epoch FROM min(received_at)) * 1000)::bigint AS first_ms,
              (extract(epoch FROM max(received_at)) * 1000)::bigint AS last_ms,
              ${auxpow ? `count(*) FILTER (WHERE ${AUXPOW('d')})` : 'NULL::bigint'} AS auxpow
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
      ORDER BY g.first_ms, parent, g.pool`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Stale parents: templates built on a recorded stale block

/** The best-chain block at height tip - N, whose arrival is a range's cutoff (none: all history, or no blocks). */
const CUT = `cut AS (
       SELECT coalesce((SELECT coalesce(b.seen_at, b.block_time) FROM blocks_best b
                         WHERE $1::int IS NOT NULL AND b.height <= (SELECT max(height) FROM blocks_best) - $1::int
                         ORDER BY b.height DESC, coalesce(b.seen_at, b.block_time) LIMIT 1),
                       '-infinity'::timestamptz) AS at
     )`;

/**
 * The rows per (stale parent, pool) of the range, from stale_parent_pools (backend/stale_parents.py: counted facts per
 * recorded stale block and pool, kept up to date after each block, plus a backfill): every pool's row of each block
 * that is stale now (stale_blocks, reorged_in_at IS NULL: judged here, at read time), from the pools not excluded,
 * whose last template (over those pools) arrived at or after the range's cutoff, compared in whole ms as the live
 * read does. Same rows, shape and order as the live read (getLiveStaleEpisodePoolRows), which is used while the
 * table is empty and stale blocks exist (before the backend has filled it).
 */
export async function getStaleEpisodePoolRows(excludePools: string[], range: UnknownParentsRange = DEFAULT_RANGE): Promise<EpisodePoolSql[]> {
  const pool = getPgPool();
  const { rows: [state] } = await pool.query<{ filled: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM stale_parent_pools) OR NOT EXISTS (SELECT 1 FROM stale_blocks) AS filled`);
  if (!state?.filled) return getLiveStaleEpisodePoolRows(excludePools, range);
  const { rows } = await pool.query<EpisodePoolSql>(
    `WITH ${CUT}, u AS (
       SELECT u.*, max(u.last_received) OVER (PARTITION BY u.prev_hash) AS parent_last
         FROM stale_parent_pools u
         JOIN stale_blocks s ON s.block_hash = stratum_prev_hash_to_block_hash(u.prev_hash) AND s.reorged_in_at IS NULL
        WHERE u.pool <> ALL ($2::text[])
     )
     SELECT encode(stratum_prev_hash_to_block_hash(u.prev_hash), 'hex') AS parent, u.pool, u.n::bigint AS n,
            (extract(epoch FROM u.first_received) * 1000)::bigint AS first_ms,
            (extract(epoch FROM u.last_received) * 1000)::bigint AS last_ms,
            NULL::bigint AS auxpow, u.conns, u.heights, u.nbits
       FROM u, cut
      WHERE CASE WHEN cut.at = '-infinity' THEN true      -- the bigint cast of an infinite epoch would fail
                 ELSE (extract(epoch FROM u.parent_last) * 1000)::bigint >= (extract(epoch FROM cut.at) * 1000)::bigint END
      ORDER BY first_ms, parent, u.pool`,
    [RANGE_BLOCKS[range], excludePools],
  );
  return rows;
}

/**
 * The rows per (stale parent, pool) of the range, read live, in the summary's shape: for every block that is stale now
 * (stale_blocks, reorged_in_at IS NULL; a non-best row of blocks is one of them by blocks_best's definition), the
 * templates built on it at its height + 1, received inside that height's window (template_height_windows()), from the
 * pools not excluded, de-duplicated and aggregated like the unknown parents' rows (no AuxPoW count: the coinbase
 * columns aren't read, they are most of a template's bytes).
 *
 * Two reads: the blocks and their height's window (only blocks whose window ends after the range's cutoff: an earlier
 * one can't have a template after it), then one read of templates with one branch per block, each with its height,
 * window and parent hash as values, so TimescaleDB excludes chunks and batches per branch (one range covering
 * every block would span the whole history). A parent is in the range when its last template arrived at or after the
 * cutoff, the unknown parents' rule.
 */
export async function getLiveStaleEpisodePoolRows(excludePools: string[], range: UnknownParentsRange = DEFAULT_RANGE): Promise<EpisodePoolSql[]> {
  const pool = getPgPool();
  const { rows: blocks } = await pool.query<{ parent: string; height: number; w_from: string; w_to: string; cut_ms: string | null }>(
    `WITH ${CUT}
     SELECT encode(s.block_hash, 'hex') AS parent, s.height + 1 AS height, w.w_from::text AS w_from, w.w_to::text AS w_to,
            CASE WHEN cut.at = '-infinity' THEN NULL ELSE (extract(epoch FROM cut.at) * 1000)::bigint END AS cut_ms
       FROM stale_blocks s CROSS JOIN LATERAL template_height_windows(s.height + 1, s.height + 1) w, cut
      WHERE s.reorged_in_at IS NULL AND w.w_to >= cut.at
      ORDER BY s.height, s.block_hash`,
    [RANGE_BLOCKS[range]],
  );
  if (blocks.length === 0) return [];
  const params: unknown[] = [excludePools];
  const branches = blocks.map(b => {
    params.push(b.height, b.w_from, b.w_to, b.parent);
    const n = params.length;
    return `SELECT t.height, t.source_id, t.prev_hash, t.received_at, t.merkle_branches, t.version, t.nbits, t.ntime,
                   t.job_id, s.name AS pool, s.conn
              FROM templates t JOIN src s ON s.id = t.source_id
             WHERE t.height = $${n - 3}::int AND t.received_at >= $${n - 2}::timestamptz AND t.received_at <= $${n - 1}::timestamptz
               AND t.prev_hash = stratum_prev_hash_to_block_hash(decode($${n}::text, 'hex'))`;
  });
  const { rows } = await pool.query<EpisodePoolSql>(
    `WITH ${dedup(branches.join('\n             UNION ALL\n'), { coinbase: false })}, ${aggregate({ auxpow: false })}`, params);
  const cut = blocks[0].cut_ms === null ? null : Number(blocks[0].cut_ms);
  if (cut === null) return rows;
  const last = new Map<string, number>();
  for (const r of rows) last.set(r.parent, Math.max(last.get(r.parent) ?? -Infinity, Number(r.last_ms)));
  return rows.filter(r => last.get(r.parent)! >= cut);
}

// ---------------------------------------------------------------------------------------------------------------------
// Invalid coinbase findings

export interface InvalidCoinbaseOffender {
  pool_name?: string;
  total_sats?: number;
  subsidy_sats?: number;
}

export interface InvalidCoinbaseFlagSql {
  height: number;                       // the best block's height = the height of the templates it was found in
  offenders: InvalidCoinbaseOffender[] | null;
  parent: string | null;                // display hex of the best block at height - 1
  parent_arrival_ms: string | null;
  arrival_ms: string;                   // the flagged block's arrival
  tip: number | null;                   // our best-chain tip now
}

/**
 * The invalid_coinbase_no_merkle findings (blocks.analysis.flags, the backend's analysis of the templates at a height:
 * a coinbase paying more than the subsidy with no transactions to pay the fees) of best-chain blocks, with the best
 * block at height - 1 and the arrivals. A handful of rows, through the blocks_interesting index.
 */
export async function getInvalidCoinbaseFlags(): Promise<InvalidCoinbaseFlagSql[]> {
  const arrival = (a: string) => `(extract(epoch FROM coalesce(${a}.seen_at, ${a}.block_time)) * 1000)::bigint`;
  const { rows } = await getPgPool().query<InvalidCoinbaseFlagSql>(
    `SELECT b.height, f->'details'->'offenders' AS offenders,
            (SELECT encode(p.block_hash, 'hex') FROM blocks_best p WHERE p.height = b.height - 1
              ORDER BY coalesce(p.seen_at, p.block_time), p.block_hash LIMIT 1) AS parent,
            (SELECT ${arrival('p')} FROM blocks_best p WHERE p.height = b.height - 1
              ORDER BY coalesce(p.seen_at, p.block_time), p.block_hash LIMIT 1) AS parent_arrival_ms,
            ${arrival('b')} AS arrival_ms,
            (SELECT max(height) FROM blocks_best) AS tip
       FROM blocks_best b, jsonb_array_elements(b.analysis->'flags') f
      WHERE b.analysis ? 'flags' AND f->>'key' = 'invalid_coinbase_no_merkle'
      ORDER BY b.height, b.block_hash`,
  );
  return rows;
}

export interface EpisodeFactsQuery {
  parent: string;                       // display hex
  height: number;
  first_ms: number;
  last_ms: number;
}

export interface EpisodeFactsSql {
  i: number;
  tip: number | null;                   // best-chain tip when the first template arrived
  tip_last: number | null;              // ... when the last one did
  bits_prev: string | null;             // bits of the best block at h - 1 (NULL bits count as no block)
  bits_at: string | null;               // ... at h
  in_stale: boolean;                    // the parent is a stale block now (stale_blocks, reorged_in_at IS NULL)
  stale_height: number | null;          // ... its height, how its header reached us, and its miner when identified
  stale_header_source: string | null;
  stale_miner: string | null;
}

/**
 * Per episode: the tip at its first and at its last template (the highest best-chain block whose arrival,
 * coalesce(seen_at, block_time), is at or before it; also at its last template, tip_last), Bitcoin's bits at h - 1 and h (the earliest
 * arrival when a height has two best rows), and whether the parent is a recorded stale block. With the summary's
 * candidates that last one is false by construction (bitcoin_parents includes stale_blocks); it is read, not assumed,
 * so the badge stays true if the candidate rule changes.
 */
export async function getEpisodeFacts(eps: EpisodeFactsQuery[]): Promise<EpisodeFactsSql[]> {
  if (eps.length === 0) return [];
  const bits = (h: string) => `(SELECT b.bits FROM blocks_best b WHERE b.height = ${h} AND b.bits IS NOT NULL
                                 ORDER BY coalesce(b.seen_at, b.block_time), b.block_hash LIMIT 1)::text`;
  // The tip at a time t: the highest best-chain block that had arrived by t. Computed for every episode's first and last
  // template in one pass, as a running maximum over blocks and episode times in arrival order (a block arriving at the
  // same instant counts as arrived), not one walk of blocks_height per lookup (~0.3 s vs ~17 s for 600 episodes).
  const { rows } = await getPgPool().query<EpisodeFactsSql>(
    `WITH e AS (
       SELECT * FROM unnest($1::text[], $2::int[], $3::bigint[], $4::bigint[]) WITH ORDINALITY AS e(parent, h, first_ms, last_ms, i)
     ), ev AS (
       SELECT coalesce(b.seen_at, b.block_time) AS t, b.height, NULL::bigint AS i, 0 AS w FROM blocks_best b
       UNION ALL SELECT timestamptz 'epoch' + e.first_ms * interval '1 millisecond', NULL, e.i, 1 FROM e
       UNION ALL SELECT timestamptz 'epoch' + e.last_ms * interval '1 millisecond', NULL, e.i, 2 FROM e
     ), tips AS (
       SELECT i, w, max(height) OVER (ORDER BY t, (height IS NULL) ROWS UNBOUNDED PRECEDING) AS tip FROM ev
     ), et AS (
       SELECT i, max(tip) FILTER (WHERE w = 1) AS tip, max(tip) FILTER (WHERE w = 2) AS tip_last
         FROM tips WHERE i IS NOT NULL GROUP BY i
     )
     SELECT e.i::int AS i,
            et.tip, et.tip_last,
            ${bits('e.h - 1')} AS bits_prev, ${bits('e.h')} AS bits_at,
            s.block_hash IS NOT NULL AS in_stale, s.height AS stale_height, s.header_source AS stale_header_source,
            s.mining_pool->>'name' AS stale_miner
       FROM e LEFT JOIN et ON et.i = e.i
       LEFT JOIN stale_blocks s ON s.block_hash = decode(e.parent, 'hex') AND s.reorged_in_at IS NULL
      ORDER BY e.i`,
    [eps.map(e => e.parent), eps.map(e => e.height), eps.map(e => e.first_ms), eps.map(e => e.last_ms)],
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
  miner: string | null;                 // the block's identified pool (a stale block's: null when it's a hidden pool)
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
            ARRAY(SELECT DISTINCT x FROM unnest(d.conns) x ORDER BY x) AS conns, l.parent_label
       FROM d JOIN (
         -- each distinct parent labelled once, by hash lookups on blocks / stale_blocks (the bitcoin_parents view would
         -- convert every stored block's hash per row: ~0.6 s a lookup, which a long episode repeats hundreds of times)
         SELECT x.prev_hash,
                CASE WHEN x.prev_hash = stratum_prev_hash_to_block_hash(decode($6, 'hex')) THEN 'this'
                     WHEN EXISTS (SELECT 1 FROM blocks_best b WHERE b.block_hash = stratum_prev_hash_to_block_hash(x.prev_hash)) THEN 'best'
                     WHEN EXISTS (SELECT 1 FROM blocks b WHERE b.block_hash = stratum_prev_hash_to_block_hash(x.prev_hash))
                       OR EXISTS (SELECT 1 FROM stale_blocks s WHERE s.block_hash = stratum_prev_hash_to_block_hash(x.prev_hash)) THEN 'stale'
                     ELSE 'other' END AS parent_label
           FROM (SELECT DISTINCT prev_hash FROM d) x
       ) l ON l.prev_hash = d.prev_hash
      ORDER BY d.received_at, d.pool, d.job_id LIMIT $7`,
    [excludePools, ids, q.height, q.from_ms, q.to_ms, q.parent, DRILL_MAX_TEMPLATES + 1])).rows;
  const blocks = await getDrillBlocks(q.height, excludePools);
  return { templates: templates.slice(0, DRILL_MAX_TEMPLATES), truncated: templates.length > DRILL_MAX_TEMPLATES, blocks };
}

/**
 * Every block we know at h - 1 and h (best chain and stale), with its arrival and miner: the drill-in's blocks, and the
 * link-preview card's (two indexed height lookups). A block off the best chain mined by an excluded pool isn't named.
 */
export async function getDrillBlocks(height: number, excludePools: string[]): Promise<DrillBlockRow[]> {
  const pool = getPgPool();
  const blocks = (await pool.query<DrillBlockRow>(
    `SELECT encode(b.block_hash, 'hex') AS block_hash, b.height,
            (extract(epoch FROM coalesce(b.seen_at, b.block_time)) * 1000)::bigint AS arrival_ms,
            EXISTS (SELECT 1 FROM blocks_best bb WHERE bb.block_hash = b.block_hash) AS best,
            nullif(b.mining_pool->>'name', '') AS miner
       FROM blocks b WHERE b.height BETWEEN $1::int - 1 AND $1::int
     UNION ALL
     SELECT encode(s.block_hash, 'hex'), s.height, (extract(epoch FROM s.first_seen) * 1000)::bigint, false,
            nullif(s.mining_pool->>'name', '')
       FROM stale_blocks s
      WHERE s.height BETWEEN $1::int - 1 AND $1::int AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.block_hash = s.block_hash)
      ORDER BY 2, 3`,
    [height])).rows;
  const hidden = new Set(excludePools.map(p => p.toLowerCase()));
  for (const b of blocks) if (!b.best && b.miner && hidden.has(b.miner.toLowerCase())) b.miner = null;
  return blocks;
}
