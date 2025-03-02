import { prisma } from './prisma';
import { LRUCache } from 'lru-cache';
import { MiningNotify } from '@prisma/client';

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
export async function getMiningNotifyByHeight(height: number) {
  try {
    // Check cache first
    const cacheKey = `block_${height}`;
    const cachedRecords = blockCache.get(cacheKey);
    
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
    throw error;
  }
} 