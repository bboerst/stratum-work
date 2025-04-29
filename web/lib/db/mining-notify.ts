import { prisma } from './prisma';
import { LRUCache } from 'lru-cache';
import { MiningNotify } from '@prisma/client';

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
    // Check cache first
    const cacheKey = `block_${height}`;
    const cachedRecords = blockCache.get(cacheKey) as MiningNotify[] | undefined; // Added type assertion
    
    if (cachedRecords) {
      return cachedRecords;
    }

    // If not in cache, fetch from database
    const records = await prisma.miningNotify.findMany({
      where: { height: height },
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