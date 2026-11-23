/**
 * The Forks page's timeline of one height (lib/forkLanes.ts): who sent work on which parent, and when. A thin read of
 * the de-duplicated templates (one stream per pool, templates_dedup): no template bytes, except the coinbase of an
 * empty template from a pool in the height's stored invalid-coinbase finding, which is what says which of its
 * templates the finding is about.
 *
 * Bounded by the height's receive window, widened to the episodes shown at that height (a feed can stay on a losing
 * parent for hours). getLaneReturns adds where a pool went back to the block before (height - 2), per
 * connection on raw templates. The pools passed as excluded are left out in SQL: POOL_BLACKLIST pools at a height above our tip
 * (getForkLanes decides per height).
 */
import { getPgPool } from './pg';

export interface LaneTemplateSql {
  pool: string;
  at_us: string;                 // first seen, µs since the epoch
  parent: string;                // display-order hex
  nbits: string;
  empty: boolean;
  coinbase1: string | null;      // only an empty template of a pool in the finding
  extranonce1: string | null;
  coinbase2: string | null;
  extranonce2_length: number | null;
}

export interface LaneFactsSql {
  t_from: string;
  t_to: string;
  active: string | null;         // our best block at height - 1
  before: string | null;         // our best block at height - 2: the block before the race's blocks
  bits_prev: string | null;
  bits_at: string | null;
  offenders: { pool_name?: string; subsidy_sats?: number | null }[] | null;
}

export async function getLaneFacts(height: number, spanFromMs: number, spanToMs: number): Promise<LaneFactsSql> {
  const best = (h: string, col: string) => `(SELECT ${col} FROM blocks_best b WHERE b.height = ${h}
                                              ORDER BY coalesce(b.seen_at, b.block_time), b.block_hash LIMIT 1)`;
  const { rows } = await getPgPool().query<LaneFactsSql>(
    `SELECT least(w.t_from, to_timestamp($2::double precision / 1000) - interval '1 second')::text AS t_from,
            greatest(w.t_to, to_timestamp($3::double precision / 1000) + interval '1 second')::text AS t_to,
            ${best('$1::int - 1', "encode(b.block_hash, 'hex')")} AS active,
            ${best('$1::int - 2', "encode(b.block_hash, 'hex')")} AS before,
            ${best('$1::int - 1', 'b.bits')}::text AS bits_prev,
            ${best('$1::int', 'b.bits')}::text AS bits_at,
            (SELECT f->'details'->'offenders'
               FROM blocks_best b, jsonb_array_elements(b.analysis->'flags') f
              WHERE b.height = $1::int AND b.analysis ? 'flags' AND f->>'key' = 'invalid_coinbase_no_merkle'
              LIMIT 1) AS offenders
       FROM height_window($1::int, $1::int) w`,
    [height, spanFromMs, spanToMs],
  );
  return rows[0];
}

export async function getLaneTemplates(
  height: number, from: string, to: string, excludePools: string[], findingPools: string[],
): Promise<LaneTemplateSql[]> {
  const params: unknown[] = [height, from, to, excludePools];
  // The coinbase columns are most of a template's bytes: they aren't in the query unless a finding needs them.
  let coinbase = `NULL::text AS coinbase1, NULL::text AS extranonce1, NULL::text AS coinbase2, NULL::int AS extranonce2_length`;
  if (findingPools.length > 0) {
    params.push(findingPools);
    const checked = `coalesce(octet_length(j.merkle_branches), 0) = 0 AND j.pool = ANY ($5::text[])`;
    coinbase = `CASE WHEN ${checked} THEN encode(j.coinbase1, 'hex') END AS coinbase1,
            CASE WHEN ${checked} THEN encode(j.extranonce1, 'hex') END AS extranonce1,
            CASE WHEN ${checked} THEN encode(j.coinbase2, 'hex') END AS coinbase2,
            CASE WHEN ${checked} THEN j.extranonce2_length::int END AS extranonce2_length`;
  }
  const { rows } = await getPgPool().query<LaneTemplateSql>(
    `SELECT j.pool, (extract(epoch FROM j.first_seen) * 1000000)::bigint AS at_us,
            encode(stratum_prev_hash_to_block_hash(j.prev_hash), 'hex') AS parent, j.nbits::text AS nbits,
            coalesce(octet_length(j.merkle_branches), 0) = 0 AS empty,
            ${coinbase}
       FROM templates_dedup($1::int, $1::int, $2::timestamptz, $3::timestamptz) j
      WHERE j.pool <> ALL ($4::text[])
      ORDER BY j.first_seen, j.source_id, j.job_id`,
    params,
  );
  return rows;
}

/**
 * Where a pool went back to the block before (`before`: our best block at height - 2): the templates at height - 1 on
 * that block that one of its connections sent right after a template of its own at this height. Only the rows that
 * start such a return, so the payload stays a few rows; the return lasts until the pool's next template here.
 *
 * Per connection, on raw templates (not templates_dedup, which joins connections and takes the first copy across
 * sites): another connection still sending its last height - 1 jobs when this one already moved isn't a return. One
 * connection per pool, the one templates_dedup ranks first among those with templates at this height (by site,
 * replica), so the return is on the same stream as the pool's lane. Bounded by the read's window (passed as values, so
 * TimescaleDB skips chunks) and by that connection's first and last template at this height: a stuck feed's re-send of
 * an old job after it moved on isn't read. At most RETURNS_LIMIT rows.
 */
export const RETURNS_LIMIT = 5000;
export async function getLaneReturns(
  height: number, before: string, from: string, to: string, excludePools: string[],
): Promise<{ pool: string; at_us: string; empty: boolean }[]> {
  const { rows } = await getPgPool().query<{ pool: string; at_us: string; empty: boolean }>(
    `WITH here AS (
       SELECT t.source_id, min(t.received_at) AS first_at, max(t.received_at) AS last_at
         FROM templates t
        WHERE t.height = $1::int AND t.received_at >= $3::timestamptz AND t.received_at <= $4::timestamptz
        GROUP BY t.source_id),
     prim AS (
       SELECT DISTINCT ON (s.name) s.name AS pool, h.source_id, h.first_at, h.last_at
         FROM here h
         JOIN (SELECT id, name, dense_rank() OVER (PARTITION BY name ORDER BY site COLLATE "C", replica COLLATE "C") AS source_rank
                 FROM sources) s ON s.id = h.source_id
        WHERE s.name <> ALL ($5::text[])
        ORDER BY s.name, s.source_rank),
     seq AS (
       SELECT p.pool, t.received_at, t.job_id, t.height, t.merkle_branches,
              lag(t.height) OVER (PARTITION BY p.pool ORDER BY t.received_at, t.job_id) AS prev_height
         FROM prim p JOIN templates t ON t.source_id = p.source_id
        WHERE t.height BETWEEN $1::int - 1 AND $1::int
          AND t.received_at >= $3::timestamptz AND t.received_at <= $4::timestamptz
          AND t.received_at >= p.first_at AND t.received_at <= p.last_at
          AND (t.height = $1::int OR t.prev_hash = stratum_prev_hash_to_block_hash(decode($2, 'hex'))))
     SELECT pool, (extract(epoch FROM received_at) * 1000000)::bigint AS at_us,
            coalesce(octet_length(merkle_branches), 0) = 0 AS empty
       FROM seq
      WHERE height = $1::int - 1 AND prev_height = $1::int
      ORDER BY received_at, pool
      LIMIT ${RETURNS_LIMIT}`,
    [height, before, from, to, excludePools],
  );
  return rows;
}

/**
 * When each pool moved on: its first template for the next height (any connection) after its last at this one, µs.
 * A pool with none in the next height's window (widened like this one's) isn't returned.
 */
export async function getLaneEnds(
  height: number, pools: string[], lastUs: string[], spanToMs: number,
): Promise<{ pool: string; end_us: string }[]> {
  if (pools.length === 0) return [];
  const from = lastUs.reduce((a, b) => (Number(b) < Number(a) ? b : a));
  const { rows: [w] } = await getPgPool().query<{ t_to: string }>(
    `SELECT greatest(t_to, to_timestamp($2::double precision / 1000) + interval '2 hours')::text AS t_to
       FROM height_window($1::int, $1::int)`, [height + 1, spanToMs]);
  const { rows } = await getPgPool().query<{ pool: string; end_us: string }>(
    `WITH v AS (SELECT * FROM unnest($2::text[], $3::bigint[]) AS v(pool, last_us))
     SELECT v.pool, (extract(epoch FROM min(t.received_at)) * 1000000)::bigint AS end_us
       FROM templates t JOIN sources s ON s.id = t.source_id JOIN v ON v.pool = s.name
      WHERE t.height = $1::int AND t.received_at >= to_timestamp($4::double precision / 1000000) AND t.received_at <= $5::timestamptz
        AND (extract(epoch FROM t.received_at) * 1000000)::bigint > v.last_us
      GROUP BY v.pool`,
    [height + 1, pools, lastUs, from, w.t_to],
  );
  return rows;
}

/**
 * When our feeds first built on each of these blocks at `height` (the pools passed as excluded left out): the first template whose
 * parent it is, µs. Where our node's arrival of a block wasn't recorded (before about 976,000), this is the line the
 * fork chart draws for it: measured from our feeds, unlike the header time its miner set (often seconds to minutes off).
 */
export async function getFirstWork(
  height: number, hashes: string[], fromMs: number, spanToMs: number, excludePools: string[],
): Promise<{ hash: string; at_us: string }[]> {
  if (hashes.length === 0) return [];
  const { rows } = await getPgPool().query<{ hash: string; at_us: string }>(
    `WITH w AS (SELECT greatest(t_to, to_timestamp($4::double precision / 1000) + interval '2 hours') AS t_to
                  FROM height_window($1::int, $1::int))
     SELECT encode(stratum_prev_hash_to_block_hash(t.prev_hash), 'hex') AS hash,
            (extract(epoch FROM min(t.received_at)) * 1000000)::bigint AS at_us
       FROM templates t JOIN sources s ON s.id = t.source_id, w
      WHERE t.height = $1::int AND t.received_at >= to_timestamp($3::double precision / 1000) AND t.received_at <= w.t_to
        AND stratum_prev_hash_to_block_hash(t.prev_hash) = ANY (SELECT decode(h, 'hex') FROM unnest($2::text[]) h)
        AND s.name <> ALL ($5::text[])
      GROUP BY 1`,
    [height, hashes, fromMs, spanToMs, excludePools],
  );
  return rows;
}
