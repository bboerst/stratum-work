// Mining-pool formatting shared by the MongoDB and Postgres block readers (moved unchanged from blocks.ts).

// Define a type for the mining pool that matches the frontend expectation
export interface MiningPool {
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
export function formatMiningPool(poolData: Record<string, unknown> | null | undefined): MiningPool | undefined {
  if (!poolData) return undefined;
  
  // In MongoDB, the pool field might be stored as 'pool' or 'mining_pool'
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
