/**
 * Postgres + TimescaleDB implementations of the web reads R1–R7 (design doc section 1; #113), selected with
 * DB_BACKEND=postgres. Each function returns exactly what its MongoDB counterpart returns; pg-mapping.ts does the
 * row → JSON conversion. All SQL is parameterized.
 *
 * `templates` holds Bitcoin templates only (the collector routes everything else to `templates_other`), so the
 * BTC-only reads need no chain filter.
 *
 * Redundant collection (several collectors per pool, `sources.replica`, possibly at several sites): reads that mean
 * "the templates" read the views `templates_dedup` / `templates_other_dedup`
 * (db/migrations/20261116200001_one_stream_per_pool.sql): one stream per pool. Per pool and height, every row of the
 * primary source (first by site, replica) is shown exactly as stored; another source's row is shown only as a gap
 * fill, while every lower-ranked source of the pool was silent (no row from 90 s before to 10 s after it). Exact
 * copies hidden this way give the primary row its first-seen time. With one collector per pool the result is the
 * raw rows. Per read:
 *   R1   templatesAtHeight     de-duplicated (realtime table history, realtime pre-fill)
 *   R2   allTemplatesAtHeight  de-duplicated, both tables (template details page)
 *   R4   firstSeenByPool       raw rows: the earliest moment any of our connections to the pool got work for the
 *                              height. That's the shown rows' earliest first_seen, or earlier when another
 *                              connection's own job (hidden as 'secondary_stream') arrived first: the pool told us
 *                              then. Latency comes from the connection that saw it first.
 *   R4b  poolNamesAtHeight     raw rows: a set of names, copies can't change it
 *   R3, R5–R7                  blocks / pools: not affected
 * MongoDB mode is unchanged (one collector per pool there).
 */
import type { MiningNotify } from '@prisma/client';
import { getPgPool } from './pg';
import {
  blockRowToBlock, blockRowToInterestingItem, firstSeenRowToItem, poolRowToPool, templateRowToMiningNotify,
  type BlockRow, type FirstSeenRow, type PgBlock, type PoolRow, type TemplateRow,
} from './pg-mapping';

async function query<T>(text: string, values: unknown[] = []): Promise<T[]> {
  const result = await getPgPool().query(text, values);
  return result.rows as T[];
}

// ── templates (R1, R2, R4) ────────────────────────────────────────────────────────────────────────────────────────

const RECEIVED_US = '(extract(epoch FROM t.received_at) * 1000000)::bigint';
const FIRST_SEEN_US = '(extract(epoch FROM j.first_seen) * 1000000)::bigint';
const OWN_RECEIVED_US = '(extract(epoch FROM j.received_at) * 1000000)::bigint';

// Columns the template responses use, from a templates_dedup / templates_other_dedup row (alias j). The coinbase and
// branch columns are the expensive ones to decompress, but both responses include them; R4 below reads only three
// columns. source_name is the pool (sources.name, the same for every replica and site). received_us is the row's own
// receive time (part of the template id), first_seen_us the time shown (earliest over it and its hidden copies).
const DEDUP_COLUMNS = `j.source_id, j.pool AS source_name, ${OWN_RECEIVED_US} AS received_us,
  ${FIRST_SEEN_US} AS first_seen_us, j.height, j.job_id, j.prev_hash, j.coinbase1, j.coinbase2, j.merkle_branches,
  j.version, j.nbits, j.ntime, j.clean_jobs, j.extranonce1, j.extranonce2_length`;

/** R1: Bitcoin templates at a height (one stream per pool across replicas), earliest first. */
export async function templatesAtHeight(height: number): Promise<MiningNotify[]> {
  const rows = await query<TemplateRow>(
    `SELECT ${DEDUP_COLUMNS}, j.latency_ms, j.latency_method::text AS latency_method
       FROM templates_dedup j
      WHERE j.height = $1
      ORDER BY j.first_seen, j.source_id, j.job_id`,
    [height],
  );
  return rows.map(templateRowToMiningNotify);
}

/**
 * R2: every template at a height, Bitcoin or not (the template details page has always shown all of them), one
 * stream per pool across replicas. Rows from templates_other carry their chain as chain_family. Latency
 * isn't part of the R2 response, so it's not read.
 */
export async function allTemplatesAtHeight(height: number): Promise<MiningNotify[]> {
  const rows = await query<TemplateRow>(
    `SELECT * FROM (
       SELECT ${DEDUP_COLUMNS}, NULL::text AS chain
         FROM templates_dedup j
        WHERE j.height = $1
       UNION ALL
       SELECT ${DEDUP_COLUMNS}, j.chain::text AS chain
         FROM templates_other_dedup j
        WHERE j.height = $1
     ) u
     ORDER BY first_seen_us, source_id, job_id`,
    [height],
  );
  return rows.map(templateRowToMiningNotify);
}

/**
 * R4: each pool's first Bitcoin template at a height, ordered by time. Grouped by source name, like MongoDB's
 * pool_name, so all replicas and sites of a pool count as one (see the report for #113). Reads the table, not
 * templates_dedup: the earliest notification on any connection (see the header), and this skips the view's sorts.
 * Note: across sites the receive times come from different clocks and network paths (design doc section 5).
 */
export async function firstSeenByPool(height: number) {
  const rows = await query<FirstSeenRow>(
    `SELECT pool_name, received_us, latency_ms FROM (
       SELECT DISTINCT ON (s.name) s.name AS pool_name, ${RECEIVED_US} AS received_us, t.latency_ms
         FROM templates t JOIN sources s ON s.id = t.source_id
        WHERE t.height = $1 AND s.name <> ''
        ORDER BY s.name, t.received_at
     ) f
     ORDER BY received_us, pool_name`,
    [height],
  );
  return rows.map(firstSeenRowToItem);
}

/** R4b (#104): names of the sources with at least one Bitcoin template at a height (a set: replicas can't change it). */
export async function poolNamesAtHeight(height: number): Promise<string[]> {
  const rows = await query<{ name: string }>(
    `SELECT s.name FROM sources s
      WHERE EXISTS (SELECT 1 FROM templates t WHERE t.source_id = s.id AND t.height = $1)
      ORDER BY s.name`,
    [height],
  );
  return [...new Set(rows.map(r => r.name))];
}

// ── blocks (R3, R5, R6) ───────────────────────────────────────────────────────────────────────────────────────────

const BLOCK_COLUMNS = `block_hash, height, extract(epoch FROM block_time)::bigint AS block_time_s, coinbase_script_sig,
  mining_pool, analysis, tx_count, size, weight, version, merkle_root, bits, nonce, difficulty`;

async function blocksWhere(where: string, order: string, limit: number, values: unknown[]): Promise<PgBlock[]> {
  const rows = await query<BlockRow>(
    `SELECT ${BLOCK_COLUMNS} FROM blocks WHERE ${where} ORDER BY ${order} LIMIT ${Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0}`,
    values,
  );
  return rows.map(blockRowToBlock);
}

/** R6. If two blocks share a height (a fork), the one we saw first wins. */
export async function getBlockByHeight(height: number): Promise<PgBlock | null> {
  const [block] = await blocksWhere('height = $1', 'seen_at ASC NULLS LAST, block_time, block_hash', 1, [height]);
  return block ?? null;
}

/** R6. Hashes are matched as stored (lower-case hex), like the MongoDB string match. */
export async function getBlockByHash(blockHash: string): Promise<PgBlock | null> {
  if (!/^(?:[0-9a-f]{2})+$/.test(blockHash)) return null;
  const [block] = await blocksWhere("block_hash = decode($1, 'hex')", 'height', 1, [blockHash]);
  return block ?? null;
}

/** R5: the same three modes and pagination fields as the MongoDB getBlocks. */
export async function getBlocks(n: number, before?: number, height?: number, after?: number) {
  if (after !== undefined) {
    const blocks = await blocksWhere('height > $1 AND height >= 1', 'height ASC, block_hash', n, [after]);
    const reversed = [...blocks].sort((a, b) => b.height - a.height);
    return { blocks: reversed, has_more: reversed.length === n, next_height: null };
  }

  if (height !== undefined) {
    const halfN = Math.floor(n / 2);
    const blocks = await blocksWhere('height >= $1 AND height <= $2', 'height DESC, block_hash', n * 2,
      [Math.max(0, height - halfN), height + halfN]);
    if (!blocks.some(b => b.height === height)) {
      const specific = await getBlockByHeight(height);
      if (specific) {
        blocks.push(specific);
        blocks.sort((a, b) => b.height - a.height);
      }
    }
    const lowestHeight = blocks.length > 0 ? Math.min(...blocks.map(b => b.height)) : null;
    return {
      blocks,
      has_more: lowestHeight !== null && lowestHeight > 0,
      next_height: lowestHeight !== null ? lowestHeight - 1 : null,
    };
  }

  const blocks = before
    ? await blocksWhere('height <= $1', 'height DESC, block_hash', n + 1, [before])
    : await blocksWhere('true', 'height DESC, block_hash', n + 1, []);
  const hasMore = blocks.length > n;
  const result = hasMore ? blocks.slice(0, n) : blocks;
  return { blocks: result, has_more: hasMore, next_height: result.length > 0 ? result[result.length - 1].height : null };
}

export async function getHighestBlock(): Promise<PgBlock | null> {
  const [block] = await blocksWhere('true', 'height DESC, block_hash', 1, []);
  return block ?? null;
}

export async function getLowestBlock(): Promise<PgBlock | null> {
  const [block] = await blocksWhere('true', 'height ASC, block_hash', 1, []);
  return block ?? null;
}

/** R3: newest 200 blocks with any analysis besides pool identification (served by the blocks_interesting index). */
export async function getInterestingBlocks() {
  const rows = await query<Pick<BlockRow, 'block_hash' | 'height' | 'analysis' | 'mining_pool'>>(
    `SELECT block_hash, height, analysis, mining_pool FROM blocks
      WHERE (analysis - 'pool_identification') <> '{}'::jsonb
      ORDER BY height DESC, block_hash
      LIMIT 200`,
  );
  return rows.map(blockRowToInterestingItem);
}

// ── pools (R7) ────────────────────────────────────────────────────────────────────────────────────────────────────

const POOL_COLUMNS = `id, name, definition->>'tag' AS tag, addresses`;

export async function getAllPools() {
  return (await query<PoolRow>(`SELECT ${POOL_COLUMNS} FROM pools ORDER BY id`)).map(poolRowToPool);
}

export async function getPoolByName(name: string) {
  const [row] = await query<PoolRow>(`SELECT ${POOL_COLUMNS} FROM pools WHERE name = $1 ORDER BY id LIMIT 1`, [name]);
  return row ? poolRowToPool(row) : null;
}

export async function findPoolsByAddress(address: string) {
  return (await query<PoolRow>(`SELECT ${POOL_COLUMNS} FROM pools WHERE addresses @> ARRAY[$1]::text[] ORDER BY id`,
    [address])).map(poolRowToPool);
}
