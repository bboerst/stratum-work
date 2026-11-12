import { prisma } from './prisma';
import { LRUCache } from 'lru-cache';
import { MiningNotify } from '@prisma/client';
import { isPostgres } from './backend';
import * as pg from './postgres';

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
    // Check cache first (Postgres results get their own keys, so a process can serve both, e.g. the parity script)
    const postgres = isPostgres();
    const cacheKey = postgres ? `pg_block_${height}` : `block_${height}`;
    const cachedRecords = blockCache.get(cacheKey) as MiningNotify[] | undefined; // Added type assertion
    
    if (cachedRecords) {
      return cachedRecords;
    }

    // If not in cache, fetch from database
    const records = postgres ? await pg.templatesAtHeight(height) : await prisma.miningNotify.findMany({
      where: {
        height,
        OR: [
          { chain_family: null },
          { chain_family: { isSet: false } },
        ],
      },
    });

    // Store in cache
    blockCache.set(cacheKey, records);
    
    return records;
  } catch (error) {
    console.error('Error fetching mining notifications:', error);
    // Depending on requirements, might want to return [] instead of throwing
    // return []; 
    throw error;
  }
}

/**
 * R2: every template at a height, including other chains' (chain_family set). Used by the template details page
 * (moved from app/api/analysis-data/route.ts). Not cached.
 */
export async function getAllMiningNotifyAtHeight(height: number): Promise<MiningNotify[]> {
  if (isPostgres()) return pg.allTemplatesAtHeight(height);
  return prisma.miningNotify.findMany({
    where: { height },
  });
}

// Shape of the R4 aggregation result
export interface PoolFirstSeenData {
  poolName: string;
  firstSeenTimestamp: string;
  firstSeenLatencyMs?: number | null;
}

interface DistinctResult {
  values: Array<string | null>;
  ok: number;
}

// Minimal interface for the expected aggregation result structure
interface AggregationResult {
  cursor: {
    firstBatch: Array<PoolFirstSeenData>;
  };
  ok: number;
}

/**
 * R4: each pool's earliest Bitcoin template at a height, sorted by time (moved from
 * app/api/block-pool-first-seen/route.ts). Returns null if MongoDB's response has an unexpected structure.
 */
export async function getFirstSeenByPool(height: number): Promise<PoolFirstSeenData[] | null> {
  if (isPostgres()) return pg.firstSeenByPool(height);

  const rawResult = await prisma.$runCommandRaw({
    aggregate: 'mining_notify', // The collection name for MiningNotify
    pipeline: [
      {
        $match: {
          height: height,
          $and: [
            { chain_family: { $exists: false } },
            { pool_name: { $ne: null } },
            { pool_name: { $ne: "" } }
          ]
        }
      },
      {
        $sort: { timestamp: 1 } // Sort by timestamp to get the earliest
      },
      {
        $group: {
          _id: "$pool_name",
          firstSeenTimestamp: { $first: "$timestamp" },
          firstSeenLatencyMs: { $first: "$lat_ms" }
        }
      },
      {
        $project: {
          _id: 0,
          poolName: "$_id",
          firstSeenTimestamp: 1,
          firstSeenLatencyMs: 1
        }
      },
      {
        $sort: { firstSeenTimestamp: 1 } // Sort final results by time
      }
    ],
    cursor: {} // Required for aggregation command
  });

  const result = rawResult as unknown as AggregationResult;
  if (result && result.cursor && result.cursor.firstBatch) {
    return result.cursor.firstBatch;
  }
  console.error("Unexpected MongoDB aggregation response structure:", result);
  return null;
}

/**
 * R4b (#104): names of the pools with at least one Bitcoin template at a height.
 * Same chain filter as getFirstSeenByPool; uses the height index.
 */
export async function getPoolNamesAtHeight(height: number): Promise<string[]> {
  if (isPostgres()) return pg.poolNamesAtHeight(height);

  const previous = (await prisma.$runCommandRaw({
    distinct: 'mining_notify',
    key: 'pool_name',
    query: { height, chain_family: { $exists: false } },
  })) as unknown as DistinctResult;
  return (previous?.values ?? []).filter((v): v is string => typeof v === 'string');
}
