import { getPool } from './pg';
import { blockRowToDoc, BlockDoc, BlockRow } from './rows';

// Read environment variable and convert to boolean
// Default to true if the variable is not set
export const enableHistoricalData = (process.env.ENABLE_HISTORICAL_DATA ?? 'true').toLowerCase() === 'true';

// Define a type for the mining pool that matches the frontend expectation
interface MiningPool {
  id: number;
  name: string;
  tag?: string;
  datum_template_creator?: string;
  link?: string;
  slug?: string;
  match_type?: string;
  identification_method?: 'address' | 'tag';
}

// Define a type for pool data with possible nested structure
interface PoolData extends Record<string, unknown> {
  mining_pool?: Record<string, unknown>;
  id?: string | number;
  name?: string;
  tag?: string;
  datum_template_creator?: string;
  link?: string;
  slug?: string;
  match_type?: string;
  identification_method?: 'address' | 'tag';
}

export type Block = Omit<BlockDoc, 'mining_pool' | 'analysis'> & {
  mining_pool: MiningPool | undefined;
  analysis: Record<string, unknown> | undefined;
};

export interface InterestingBlockItem {
  height: number;
  block_hash: string;
  analysis: Record<string, unknown> | null;
  mining_pool: Record<string, unknown> | null;
}

// Safe helper to read a string property from an unknown object without using any
function readString(obj: unknown, key: string): string | undefined {
  if (obj && typeof obj === 'object' && key in (obj as Record<string, unknown>)) {
    const value = (obj as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

/**
 * Convert pool data from database to MiningPool format
 */
function formatMiningPool(poolData: Record<string, unknown> | null | undefined): MiningPool | undefined {
  if (!poolData) return undefined;

  // Check if we're dealing with a nested structure
  const typedPoolData = poolData as PoolData;
  const pool = typedPoolData.mining_pool || typedPoolData;

  // Ensure we have at least an id and name
  if (!pool.id && !pool.name) {
    console.warn('Pool data missing required fields:', pool);
    return undefined;
  }

  const result = {
    id: typeof pool.id === 'string' ? parseInt(pool.id as string) : (pool.id as number) || 0,
    name: (pool.name as string) || 'Unknown',
    tag: readString(pool, 'tag'),
    datum_template_creator: readString(pool, 'datum_template_creator'),
    link: pool.link as string | undefined,
    slug: pool.slug as string | undefined,
    match_type: pool.match_type as string | undefined,
    identification_method: pool.identification_method as ('address' | 'tag' | undefined)
  };

  return result;
}

function toBlock(row: BlockRow): Block {
  const doc = blockRowToDoc(row);
  return {
    ...doc,
    mining_pool: formatMiningPool(doc.mining_pool),
    analysis: doc.analysis ?? undefined,
  };
}

async function queryBlocks(sql: string, params: unknown[]): Promise<Block[]> {
  const { rows } = await getPool().query<BlockRow>(sql, params);
  return rows.map(toBlock);
}

/**
 * Get blocks with pagination
 * @param n Number of blocks to fetch
 * @param before Optional height to fetch blocks before
 * @param height Optional specific height to fetch blocks around
 * @param after Optional height to fetch blocks after
 * @returns Blocks and pagination info
 */
export async function getBlocks(n: number = 20, before?: number, height?: number, after?: number) {
  if (!enableHistoricalData) {
    console.log('Historical data is disabled. Skipping fetch for blocks.');
    return { blocks: [] as Block[], has_more: false, next_height: null as number | null };
  }

  if (after !== undefined) {
    // Exclude non-positive heights (like -1 for being-mined)
    const blocks = await queryBlocks(
      'SELECT * FROM blocks WHERE height > $1 AND height >= 1 ORDER BY height ASC LIMIT $2',
      [after, n],
    );
    blocks.sort((a, b) => b.height - a.height);
    return {
      blocks,
      has_more: blocks.length === n, // If we got as many blocks as we asked for, there might be more
      next_height: null as number | null, // Not applicable for "after" query
    };
  }

  if (height !== undefined) {
    const halfN = Math.floor(n / 2);
    const blocks = await queryBlocks(
      'SELECT * FROM blocks WHERE height BETWEEN $1 AND $2 ORDER BY height DESC LIMIT $3',
      [Math.max(0, height - halfN), height + halfN, n * 2],
    );

    if (!blocks.some(block => block.height === height)) {
      const specificBlock = await getBlockByHeight(height);
      if (specificBlock) {
        blocks.push(specificBlock);
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

  const blocks = await queryBlocks(
    'SELECT * FROM blocks WHERE ($1::int IS NULL OR height <= $1) ORDER BY height DESC LIMIT $2',
    [before ? before : null, n + 1],
  );
  const hasMore = blocks.length > n;
  const resultBlocks = hasMore ? blocks.slice(0, n) : blocks;
  return {
    blocks: resultBlocks,
    has_more: hasMore,
    next_height: resultBlocks.length > 0 ? resultBlocks[resultBlocks.length - 1].height : null,
  };
}

/**
 * Get a single block by height
 * @param height Block height
 * @returns Block or null if not found
 */
export async function getBlockByHeight(height: number): Promise<Block | null> {
  if (!enableHistoricalData) {
    console.log(`Historical data is disabled. Skipping fetch for block height ${height}.`);
    return null;
  }
  const blocks = await queryBlocks('SELECT * FROM blocks WHERE height = $1', [height]);
  return blocks[0] ?? null;
}

/**
 * Get a single block by hash
 * @param blockHash Block hash
 * @returns Block or null if not found
 */
export async function getBlockByHash(blockHash: string): Promise<Block | null> {
  if (!enableHistoricalData) {
    console.log(`Historical data is disabled. Skipping fetch for block hash ${blockHash}.`);
    return null;
  }
  const blocks = await queryBlocks('SELECT * FROM blocks WHERE block_hash = $1', [blockHash]);
  return blocks[0] ?? null;
}

/**
 * Blocks whose analysis contains anything besides pool identification, newest first
 */
export async function getInterestingBlocks(limit: number): Promise<InterestingBlockItem[]> {
  const { rows } = await getPool().query<InterestingBlockItem>(
    `SELECT height, block_hash, analysis, mining_pool FROM blocks
     WHERE analysis IS NOT NULL AND (analysis - 'pool_identification') <> '{}'::jsonb
     ORDER BY height DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

/**
 * Get the highest processed block
 * @returns The highest block or null if none exist
 */
export async function getHighestBlock(): Promise<BlockDoc | null> {
  if (!enableHistoricalData) {
    console.log('Historical data is disabled. Skipping fetch for highest block.');
    return null;
  }

  try {
    const { rows } = await getPool().query<BlockRow>('SELECT * FROM blocks ORDER BY height DESC LIMIT 1');
    return rows[0] ? blockRowToDoc(rows[0]) : null;
  } catch (error) {
    console.error('Error fetching highest block:', error);
    return null;
  }
}

/**
 * Get the lowest processed block
 * @returns The lowest block or null if none exist
 */
export async function getLowestBlock(): Promise<BlockDoc | null> {
  if (!enableHistoricalData) {
    console.log('Historical data is disabled. Skipping fetch for lowest block.');
    return null;
  }

  try {
    const { rows } = await getPool().query<BlockRow>('SELECT * FROM blocks ORDER BY height ASC LIMIT 1');
    return rows[0] ? blockRowToDoc(rows[0]) : null;
  } catch (error) {
    console.error('Error fetching lowest block:', error);
    return null;
  }
}
