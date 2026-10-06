import { getPool } from './pg';
import type { PoolDef } from '@/lib/templates/types';
import { parsePoolDefs } from '@/lib/templates/identify';

/** Full mempool pool definitions (tags, regexes, addresses) from `pools.doc`. */
export async function getPoolDefs(): Promise<PoolDef[]> {
  const { rows } = await getPool().query<{ doc: unknown }>('SELECT doc FROM pools ORDER BY id');
  return parsePoolDefs(rows.map(r => r.doc));
}

export interface PoolData {
  id: number;
  name: string;
  slug?: string;
  link?: string;
  tag?: string;
  match_type?: string;
  identification_method?: 'address' | 'tag';
  [key: string]: unknown;
}

export interface Pool {
  id: string;
  name: string;
  tag: string | null;
  addresses: string[];
}

interface PoolRow {
  id: number;
  name: string;
  tag: string | null;
  addresses: string[];
}

const SELECT_POOLS = 'SELECT id, name, tag, addresses FROM pools';

function toPool(r: PoolRow): Pool {
  return { id: String(r.id), name: r.name, tag: r.tag, addresses: r.addresses };
}

/**
 * Get all pools
 * @returns Array of all pools
 */
export async function getAllPools(): Promise<Pool[]> {
  try {
    const { rows } = await getPool().query<PoolRow>(`${SELECT_POOLS} ORDER BY id`);
    return rows.map(toPool);
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
export async function getPoolByName(name: string): Promise<Pool | null> {
  const { rows } = await getPool().query<PoolRow>(`${SELECT_POOLS} WHERE name = $1 ORDER BY id LIMIT 1`, [name]);
  return rows[0] ? toPool(rows[0]) : null;
}

/**
 * Find pools by address
 * @param address Bitcoin address
 * @returns Array of pools that use this address
 */
export async function findPoolsByAddress(address: string): Promise<Pool[]> {
  const { rows } = await getPool().query<PoolRow>(`${SELECT_POOLS} WHERE $1 = ANY(addresses) ORDER BY id`, [address]);
  return rows.map(toPool);
}
