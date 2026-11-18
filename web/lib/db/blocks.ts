import * as pg from './postgres';

// Read environment variable and convert to boolean
// Default to true if the variable is not set
export const enableHistoricalData = (process.env.ENABLE_HISTORICAL_DATA ?? 'true').toLowerCase() === 'true';

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
    return { blocks: [], has_more: false, next_height: null };
  }
  return pg.getBlocks(n, before, height, after);
}

/**
 * Get a single block by height
 * @param height Block height
 * @returns Block or null if not found
 */
export async function getBlockByHeight(height: number) {
  if (!enableHistoricalData) {
    console.log(`Historical data is disabled. Skipping fetch for block height ${height}.`);
    return null;
  }
  return pg.getBlockByHeight(height);
}

/** Which of these block hashes we have a stored block for; see lib/forkStatus.ts. */
export async function knownBlockHashes(hashes: string[]): Promise<Set<string>> {
  if (!enableHistoricalData || hashes.length === 0) return new Set();
  return pg.knownBlockHashes(hashes);
}

/**
 * Get a single block by hash (a block a reorg disconnected is still found, flagged `stale: true`)
 * @param blockHash Block hash
 * @returns Block or null if not found
 */
export async function getBlockByHash(blockHash: string) {
  if (!enableHistoricalData) {
    console.log(`Historical data is disabled. Skipping fetch for block hash ${blockHash}.`);
    return null;
  }
  return pg.getBlockByHash(blockHash);
}

/**
 * Get the highest processed block
 * @returns The highest block or null if none exist
 */
export async function getHighestBlock() {
  if (!enableHistoricalData) {
    console.log('Historical data is disabled. Skipping fetch for highest block.');
    return null;
  }
  return pg.getHighestBlock();
}

/**
 * Get the lowest processed block
 * @returns The lowest block or null if none exist
 */
export async function getLowestBlock() {
  if (!enableHistoricalData) {
    console.log('Historical data is disabled. Skipping fetch for lowest block.');
    return null;
  }
  return pg.getLowestBlock();
}

export interface InterestingBlockItem {
  height: number;
  block_hash: string;
  analysis?: Record<string, unknown>;
  mining_pool?: Record<string, unknown>;
}

/**
 * R3: the newest 200 blocks with any analysis result besides pool identification (moved from
 * app/api/analysis-data/route.ts). Throws on database errors; the route decides what to return.
 */
export async function getInterestingBlocks(): Promise<InterestingBlockItem[]> {
  return pg.getInterestingBlocks();
}
