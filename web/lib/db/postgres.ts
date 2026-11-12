/**
 * Postgres + TimescaleDB implementations of the web reads R1–R7 (design doc section 1; #113), selected with
 * DB_BACKEND=postgres. Each function returns exactly what its MongoDB counterpart returns; pg-mapping.ts does the
 * row → JSON conversion. All SQL is parameterized.
 *
 * `templates` holds Bitcoin templates only (the collector routes everything else to `templates_other`), so the
 * BTC-only reads need no chain filter.
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

// Columns the template responses use. The coinbase and branch columns are the expensive ones to decompress, but
// both responses include them; R4 below reads only three columns.
const TEMPLATE_COLUMNS = `t.source_id, s.name AS source_name, ${RECEIVED_US} AS received_us, t.height, t.job_id,
  t.prev_hash, t.coinbase1, t.coinbase2, t.merkle_branches, t.version, t.nbits, t.ntime, t.clean_jobs,
  t.extranonce1, t.extranonce2_length`;

/** R1: Bitcoin templates at a height, earliest first. */
export async function templatesAtHeight(height: number): Promise<MiningNotify[]> {
  const rows = await query<TemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS}, t.latency_ms, t.latency_method::text AS latency_method
       FROM templates t JOIN sources s ON s.id = t.source_id
      WHERE t.height = $1
      ORDER BY t.received_at, t.source_id, t.job_id`,
    [height],
  );
  return rows.map(templateRowToMiningNotify);
}

/**
 * R2: every template at a height, Bitcoin or not (the template details page has always shown all of them).
 * Rows from templates_other carry their chain as chain_family. Latency isn't part of the R2 response, so it's not read.
 */
export async function allTemplatesAtHeight(height: number): Promise<MiningNotify[]> {
  const rows = await query<TemplateRow>(
    `SELECT * FROM (
       SELECT ${TEMPLATE_COLUMNS}, NULL::text AS chain
         FROM templates t JOIN sources s ON s.id = t.source_id
        WHERE t.height = $1
       UNION ALL
       SELECT ${TEMPLATE_COLUMNS}, t.chain::text AS chain
         FROM templates_other t JOIN sources s ON s.id = t.source_id
        WHERE t.height = $1
     ) u
     ORDER BY received_us, source_id, job_id`,
    [height],
  );
  return rows.map(templateRowToMiningNotify);
}

/**
 * R4: each pool's first Bitcoin template at a height, ordered by time. Grouped by source name, like MongoDB's
 * pool_name (with several collection sites, one name can have a source per site; see the report for #113).
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

/** R4b (#104): names of the sources with at least one Bitcoin template at a height. */
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
