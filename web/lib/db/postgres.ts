/**
 * Postgres + TimescaleDB implementations of the web reads R1–R7 (design doc section 1; #113). pg-mapping.ts does the
 * row → JSON conversion. All SQL is parameterized.
 *
 * Height reads also bound receive time (docs/design/one-templates-table.md): a template for height h is received
 * between the block at h - 1 arriving and the block at h arriving (height_window(), from stored blocks, 2 h margin).
 * That keeps out what a height alone can't: a stuck feed re-sending an old job hours later at its old height, and
 * another chain's template at a height Bitcoin passed long ago. The window is fetched first, in its own round trip,
 * and passed as parameters: node-postgres sends unnamed statements, so each plan is custom and TimescaleDB drops the
 * chunks outside it at planning. Computed inside the same query it wouldn't.
 *
 * Redundant collection (several collectors per pool, `sources.replica`, possibly at several sites): reads that mean
 * "the templates" read `templates_dedup(h1, h2, t1, t2)` (db/migrations/20261118000006_one_table_reads.sql; the view
 * of db/migrations/20261116200001_one_stream_per_pool.sql with bounds): one stream per pool. Per pool and height, every row of the
 * primary source (first by site, replica) is shown exactly as stored; another source's row is shown only as a gap
 * fill, while every lower-ranked source of the pool was silent (no row from 90 s before to 10 s after it). Exact
 * copies hidden this way give the primary row its first-seen time. With one collector per pool the result is the
 * raw rows. Per read:
 *   R1   templatesAtHeight     de-duplicated (realtime table history, realtime pre-fill)
 *   R2   allTemplatesAtHeight  de-duplicated, every row at the height whenever received (template details page)
 *   R4   firstSeenByPool       raw rows: the earliest moment any of our connections to the pool got work for the
 *                              height. That's the shown rows' earliest first_seen, or earlier when another
 *                              connection's own job (hidden as 'secondary_stream') arrived first: the pool told us
 *                              then. Latency comes from the connection that saw it first.
 *   R4b  poolNamesAtHeight     raw rows: a set of names, copies can't change it
 *   R3, R5–R7                  blocks / pools: not affected by de-duplication (blocks: see Reorgs below)
 *
 * Reorgs (#194): `blocks` keeps blocks a reorg disconnected (keyed by hash, so the losing and the winning block at a
 * height coexist). Reads that mean "the block at height h", "recent blocks" or "the tip" read the view `blocks_best`
 * (db/migrations/20261116300001_blocks_best.sql): blocks without those recorded in `stale_blocks` as currently stale
 * (reorged_in_at IS NULL; a block that went stale and became active again is shown). Per read:
 *   R3   getInterestingBlocks              best chain
 *   R5   getBlocks (all three modes)       best chain
 *   R6   getBlockByHeight                  best chain
 *   R6   getBlockByHash                    blocks: a stale block is still found by its hash, flagged `stale: true`
 *        getHighestBlock / getLowestBlock  best chain (the tip, also used by the realtime pre-fill and analysis)
 * With no stale_blocks rows the view is exactly `blocks`, so behavior is unchanged.
 */
import { getPgPool } from './pg';
import {
  blockRowToBlock, blockRowToInterestingItem, firstSeenRowToItem, poolRowToPool, templateRowToMiningNotify,
  type BlockRow, type FirstSeenRow, type MiningNotify, type PgBlock, type PoolRow, type StaleSibling, type TemplateRow,
} from './pg-mapping';

async function query<T>(text: string, values: unknown[] = []): Promise<T[]> {
  const result = await getPgPool().query(text, values);
  return result.rows as T[];
}

/** The receive-time window of the templates for heights [from, to] (height_window(), db migration 20261118000006), as
 * text so '-infinity' / 'infinity' round-trip as parameters. */
async function heightWindow(from: number, to: number = from): Promise<[string, string]> {
  const [w] = await query<{ t_from: string; t_to: string }>(
    'SELECT t_from::text AS t_from, t_to::text AS t_to FROM height_window($1, $2)', [from, to]);
  return [w.t_from, w.t_to];
}

// ── templates (R1, R2, R4) ────────────────────────────────────────────────────────────────────────────────────────

const RECEIVED_US = '(extract(epoch FROM t.received_at) * 1000000)::bigint';
const FIRST_SEEN_US = '(extract(epoch FROM j.first_seen) * 1000000)::bigint';
const OWN_RECEIVED_US = '(extract(epoch FROM j.received_at) * 1000000)::bigint';

// Columns the template responses use, from a templates_dedup row (alias j). The coinbase and
// branch columns are the expensive ones to decompress, but both responses include them; R4 below reads only three
// columns. source_name is the pool (sources.name, the same for every replica and site). received_us is the row's own
// receive time (part of the template id), first_seen_us the time shown (earliest over it and its hidden copies).
const DEDUP_COLUMNS = `j.source_id, j.pool AS source_name, ${OWN_RECEIVED_US} AS received_us,
  ${FIRST_SEEN_US} AS first_seen_us, j.height, j.job_id, j.prev_hash, j.coinbase1, j.coinbase2, j.merkle_branches,
  j.version, j.nbits, j.ntime, j.clean_jobs, j.extranonce1, j.extranonce2_length`;

/** Whether a height's templates can't change any more: its receive window has closed (t_to is infinity above the tip). */
export async function isHeightFinal(height: number): Promise<boolean> {
  const [w] = await query<{ final: boolean }>('SELECT t_to < now() AS final FROM height_window($1, $1)', [height]);
  return w?.final === true;
}

/** R1: Bitcoin templates at a height (one stream per pool across replicas), earliest first. */
export async function templatesAtHeight(height: number): Promise<MiningNotify[]> {
  const [from, to] = await heightWindow(height);
  const rows = await query<TemplateRow>(
    `SELECT ${DEDUP_COLUMNS}, j.latency_ms, j.latency_method::text AS latency_method
       FROM templates_dedup($1, $1, $2, $3) j
      ORDER BY j.first_seen, j.source_id, j.job_id`,
    [height, from, to],
  );
  return rows.map(templateRowToMiningNotify);
}

/**
 * R2: every template at a height, received whenever (the template details page has always shown all of them: stuck
 * feeds' late re-sends and other chains' templates at that height included), one stream per pool across replicas.
 * Latency isn't part of the R2 response, so it's not read.
 */
export async function allTemplatesAtHeight(height: number): Promise<MiningNotify[]> {
  const rows = await query<TemplateRow>(
    `SELECT ${DEDUP_COLUMNS}
       FROM templates_dedup($1, $1, '-infinity', 'infinity') j   -- every row at the height, whenever received
      ORDER BY j.first_seen, j.source_id, j.job_id`,
    [height],
  );
  return rows.map(templateRowToMiningNotify);
}

/**
 * R4: each pool's first Bitcoin template at a height, ordered by time. Grouped by source name (the pool name), so
 * all replicas and sites of a pool count as one (see the report for #113). Reads the table, not
 * templates_dedup: the earliest notification on any connection (see the header), and this skips the view's sorts.
 * Note: across sites the receive times come from different clocks and network paths (design doc section 5).
 */
export async function firstSeenByPool(height: number) {
  const [from, to] = await heightWindow(height);
  const rows = await query<FirstSeenRow>(
    `SELECT pool_name, received_us, latency_ms FROM (
       SELECT DISTINCT ON (s.name) s.name AS pool_name, ${RECEIVED_US} AS received_us, t.latency_ms
         FROM templates t JOIN sources s ON s.id = t.source_id
        WHERE t.height = $1 AND t.received_at >= $2 AND t.received_at <= $3 AND s.name <> ''
        ORDER BY s.name, t.received_at
     ) f
     ORDER BY received_us, pool_name`,
    [height, from, to],
  );
  return rows.map(firstSeenRowToItem);
}

/** R4b (#104): names of the sources with at least one Bitcoin template at a height (a set: replicas can't change it). */
export async function poolNamesAtHeight(height: number): Promise<string[]> {
  const rows = await query<{ name: string }>(
    `SELECT s.name FROM sources s
      WHERE EXISTS (SELECT 1 FROM templates t WHERE t.source_id = s.id AND t.height = $1
                       AND t.received_at >= $2 AND t.received_at <= $3)
      ORDER BY s.name`,
    [height, ...(await heightWindow(height))],
  );
  return [...new Set(rows.map(r => r.name))];
}

// ── blocks (R3, R5, R6) ───────────────────────────────────────────────────────────────────────────────────────────

const BLOCK_COLUMNS = `block_hash, height, extract(epoch FROM block_time)::bigint AS block_time_s, coinbase_script_sig,
  mining_pool, analysis, tx_count, size, weight, version, merkle_root, bits, nonce, difficulty`;

/** Best-chain blocks (`blocks_best`, see the header): every read here except the lookup by hash. */
async function blocksWhere(where: string, order: string, limit: number, values: unknown[]): Promise<PgBlock[]> {
  const rows = await query<BlockRow>(
    `SELECT ${BLOCK_COLUMNS} FROM blocks_best WHERE ${where} ORDER BY ${order} LIMIT ${Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0}`,
    values,
  );
  return rows.map(blockRowToBlock);
}

/**
 * R6: the best-chain block at a height (blocks recorded as stale are skipped). If two non-stale blocks share a height
 * (a fork the stale-block tracker hasn't recorded yet, or MongoDB-era data), the one we saw first wins.
 */
export async function getBlockByHeight(height: number): Promise<PgBlock | null> {
  const [block] = await blocksWhere('height = $1', 'seen_at ASC NULLS LAST, block_time, block_hash', 1, [height]);
  return block ?? null;
}

/**
 * R6. Hashes are matched as stored (lower-case hex). Reads `blocks`, not the best chain: a block a reorg disconnected
 * is still found by its hash, with `stale: true` (the field is absent otherwise).
 */
/**
 * Which of these block hashes (display order, lower-case hex) we know: stored in `blocks`, or recorded in
 * `stale_blocks` as a currently stale side block (headers-only side blocks are only there). For the fork visual's
 * stale vs unknown label (lib/forkStatus.ts).
 */
export async function knownBlockHashes(hashes: string[]): Promise<Set<string>> {
  const valid = [...new Set(hashes.map(h => h.toLowerCase()))].filter(h => /^(?:[0-9a-f]{2})+$/.test(h));
  if (valid.length === 0) return new Set();
  const rows = await query<{ h: string }>(
    `WITH q AS (SELECT decode(x, 'hex') AS bh FROM unnest($1::text[]) x)
     SELECT encode(b.block_hash, 'hex') AS h FROM blocks b JOIN q ON b.block_hash = q.bh
     UNION
     SELECT encode(s.block_hash, 'hex') FROM stale_blocks s JOIN q ON s.block_hash = q.bh WHERE s.reorged_in_at IS NULL`,
    [valid],
  );
  return new Set(rows.map(r => r.h));
}

export async function getBlockByHash(blockHash: string): Promise<PgBlock | null> {
  if (!/^(?:[0-9a-f]{2})+$/.test(blockHash)) return null;
  const [row] = await query<BlockRow>(
    `SELECT ${BLOCK_COLUMNS},
            EXISTS (SELECT 1 FROM stale_blocks s WHERE s.block_hash = b.block_hash AND s.reorged_in_at IS NULL) AS stale
       FROM blocks b WHERE b.block_hash = decode($1, 'hex') LIMIT 1`,
    [blockHash],
  );
  return row ? blockRowToBlock(row) : null;
}

/**
 * The stale side blocks recorded at these blocks' heights (`stale_blocks`, currently stale), attached to each best
 * block as `stale_siblings`: other blocks found at the same height. For the blocks strip's stacked tiles. One query
 * per page of blocks; a block without siblings gets no field.
 */
export async function withStaleSiblings<T extends { height: number; block_hash: string; stale_siblings?: StaleSibling[] }>(blocks: T[]): Promise<T[]> {
  if (blocks.length === 0) return blocks;
  const heights = [...new Set(blocks.map(b => b.height))];
  const rows = await query<{ height: number; h: string; pool: string | null }>(
    `SELECT height, encode(block_hash, 'hex') AS h, mining_pool->>'name' AS pool FROM stale_blocks
      WHERE reorged_in_at IS NULL AND height = ANY($1::int[]) ORDER BY height, first_seen, block_hash`,
    [heights],
  );
  const byHeight = new Map<number, StaleSibling[]>();
  for (const r of rows) {
    const list = byHeight.get(r.height) ?? [];
    list.push({ block_hash: r.h, pool: r.pool || null });
    byHeight.set(r.height, list);
  }
  for (const b of blocks) {
    const siblings = (byHeight.get(b.height) ?? []).filter(x => x.block_hash !== b.block_hash);
    if (siblings.length > 0) b.stale_siblings = siblings;
  }
  return blocks;
}

/** R5 without stale siblings. */
async function getBlocksBare(n: number, before?: number, height?: number, after?: number) {
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

/** R5: blocks after / around / before a height (three modes), with pagination fields and stale siblings. */
export async function getBlocks(n: number, before?: number, height?: number, after?: number) {
  const page = await getBlocksBare(n, before, height, after);
  return { ...page, blocks: await withStaleSiblings(page.blocks) };
}

/** The best-chain tip (a reorged-out block at a greater height than the new tip is not the tip). */
export async function getHighestBlock(): Promise<PgBlock | null> {
  const [block] = await blocksWhere('true', 'height DESC, block_hash', 1, []);
  return block ?? null;
}

export async function getLowestBlock(): Promise<PgBlock | null> {
  const [block] = await blocksWhere('true', 'height ASC, block_hash', 1, []);
  return block ?? null;
}

/**
 * R3: newest 200 best-chain blocks with any analysis besides pool identification (served by the blocks_interesting
 * index; blocks recorded as stale are skipped).
 */
export async function getInterestingBlocks() {
  const rows = await query<Pick<BlockRow, 'block_hash' | 'height' | 'analysis' | 'mining_pool'>>(
    `SELECT block_hash, height, analysis, mining_pool FROM blocks_best
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
