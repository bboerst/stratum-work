import * as pg from './postgres';

/**
 * Get all pools
 * @returns Array of all pools
 */
export async function getAllPools() {
  return pg.getAllPools();
}

/**
 * Get a pool by name
 * @param name Pool name
 * @returns Pool or null if not found
 */
export async function getPoolByName(name: string) {
  return pg.getPoolByName(name);
}

/**
 * Find pools by address
 * @param address Bitcoin address
 * @returns Array of pools that use this address
 */
export async function findPoolsByAddress(address: string) {
  return pg.findPoolsByAddress(address);
}
