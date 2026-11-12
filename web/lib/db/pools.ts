import { prisma } from './prisma';
import { isPostgres } from './backend';
import * as pg from './postgres';

// Define the pool data interface with an index signature to make it compatible with Prisma's InputJsonValue
export interface PoolData {
  id: number;
  name: string;
  slug?: string;
  link?: string;
  tag?: string;
  match_type?: string;
  identification_method?: 'address' | 'tag';
  [key: string]: unknown; // Add index signature to make it compatible with Prisma's InputJsonObject
}

/**
 * Get all pools
 * @returns Array of all pools
 */
export async function getAllPools() {
  if (isPostgres()) return pg.getAllPools();
  try {
    return await prisma.pool.findMany();
  } catch (error) {
    console.error('Error fetching pools:', error);
    throw error;
  }
}

/**
 * Get a pool by name
 * @param name Pool name
 * @returns Pool or null if not found
 */
export async function getPoolByName(name: string) {
  if (isPostgres()) return pg.getPoolByName(name);
  return prisma.pool.findFirst({
    where: { name },
  });
}

/**
 * Find pools by address
 * @param address Bitcoin address
 * @returns Array of pools that use this address
 */
export async function findPoolsByAddress(address: string) {
  if (isPostgres()) return pg.findPoolsByAddress(address);
  return prisma.pool.findMany({
    where: {
      addresses: {
        has: address,
      },
    },
  });
} 