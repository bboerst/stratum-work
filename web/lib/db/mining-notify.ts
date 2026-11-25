import { LRUCache } from 'lru-cache';
import * as pg from './postgres';
import type { MiningNotify } from './pg-mapping';

export type { MiningNotify } from './pg-mapping';

// Read environment variable and convert to boolean
// Default to true if the variable is not set
const enableHistoricalData = (process.env.ENABLE_HISTORICAL_DATA ?? 'true').toLowerCase() === 'true';

// Initialize LRU cache with a max size of 500MB
const blockCache = new LRUCache({
  maxSize: 500 * 1024 * 1024,
  sizeCalculation: (value: MiningNotify[]) => {
    return JSON.stringify(value).length;
  },
  allowStale: false,
  updateAgeOnGet: true,
});

/**
 * A height's templates are cached for good only once they can't change any more: once the height's receive window
 * has closed (height_window().t_to, db migration 20261118000006: two hours after its block arrived; infinity above the
 * stored tip). Facts only, no block-count guess. Until then (the height being mined, a future height, one whose block
 * arrived recently) a read is cached for UNFINISHED_TTL_MS only: caching the first read for good froze a partial (or,
 * for a future height, empty) answer until the process restarted.
 */
export const UNFINISHED_TTL_MS = 15_000;

export async function isHeightFinal(height: number): Promise<boolean> {
  return pg.isHeightFinal(height);
}

/**
 * Get mining notifications for a specific block height
 * @param height Block height
 * @returns Array of mining notifications
 */
export async function getMiningNotifyByHeight(height: number): Promise<MiningNotify[]> {
  // Check the flag first
  if (!enableHistoricalData) {
    console.log('Historical data is disabled. Skipping fetch for mining notifications.');
    return []; // Return empty array if disabled
  }

  try {
    const cacheKey = `block_${height}`;
    const cachedRecords = blockCache.get(cacheKey) as MiningNotify[] | undefined; // Added type assertion

    if (cachedRecords) {
      return cachedRecords;
    }

    // If not in cache, fetch from database. Finality is checked first: a height that becomes final between the two
    // reads is then only cached briefly, never the other way round.
    const final = await isHeightFinal(height);
    const records = await fetchMiningNotifyByHeight(height);

    // Store in cache: for good if final, briefly otherwise
    blockCache.set(cacheKey, records, final ? undefined : { ttl: UNFINISHED_TTL_MS });

    return records;
  } catch (error) {
    console.error('Error fetching mining notifications:', error);
    throw error;
  }
}

/**
 * Bitcoin templates at a height, straight from the database (no cache). Used by getMiningNotifyByHeight and by the
 * realtime pre-fill (#130), which reads the height still being mined: caching that forever would freeze it.
 * Returns [] when historical data is disabled.
 */
export async function fetchMiningNotifyByHeight(height: number): Promise<MiningNotify[]> {
  if (!enableHistoricalData) return [];
  return pg.templatesAtHeight(height);
}

/** R1 over heights [from, to], in one statement (one snapshot): the realtime pre-fill. Not cached. */
export async function fetchMiningNotifyAtHeights(from: number, to: number): Promise<MiningNotify[]> {
  if (!enableHistoricalData) return [];
  return pg.templatesAtHeights(from, to);
}

/**
 * R2: every template at a height, whenever received. Used by the template details page (moved from
 * app/api/analysis-data/route.ts). Not cached.
 */
export async function getAllMiningNotifyAtHeight(height: number): Promise<MiningNotify[]> {
  return pg.allTemplatesAtHeight(height);
}

// Shape of the R4 result
export interface PoolFirstSeenData {
  poolName: string;
  firstSeenTimestamp: string;
  firstSeenLatencyMs?: number | null;
}

/**
 * R4: each pool's earliest Bitcoin template at a height, sorted by time (moved from
 * app/api/block-pool-first-seen/route.ts).
 */
export async function getFirstSeenByPool(height: number): Promise<PoolFirstSeenData[] | null> {
  return pg.firstSeenByPool(height);
}

/** R4b (#104): names of the pools with at least one Bitcoin template at a height. */
export async function getPoolNamesAtHeight(height: number): Promise<string[]> {
  return pg.poolNamesAtHeight(height);
}
