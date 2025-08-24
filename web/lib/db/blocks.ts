import { prisma } from './prisma';

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

// Define a type for raw MongoDB document
interface RawDocument {
  _document?: {
    mining_pool?: Record<string, unknown>;
  };
  mining_pool?: Record<string, unknown>;
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

// Define MongoDB response types
interface MongoDBCursor {
  firstBatch: MongoDBBlock[];
  id?: string;
  ns?: string;
}

interface MongoDBCommandResult {
  cursor: MongoDBCursor;
  ok: number;
  n?: number;
  [key: string]: unknown;
}

// Define Block type for MongoDB responses
interface MongoDBBlock {
  _id: { toString(): string };
  height: number;
  block_hash: string;
  timestamp: number;
  coinbase_script_sig: string;
  pool?: Record<string, unknown>;
  mining_pool?: Record<string, unknown>;
  analysis?: Record<string, unknown>;
  transactions?: number;
  size?: number;
  weight?: number;
  version?: number;
  merkle_root?: string;
  bits?: string;
  nonce?: number;
  difficulty?: number;
  [key: string]: unknown;
}

/**
 * Convert pool data from database to MiningPool format
 */
function formatMiningPool(poolData: Record<string, unknown> | null | undefined): MiningPool | undefined {
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
    tag: pool.tag as string | undefined,
    datum_template_creator: (pool as any).datum_template_creator as string | undefined,
    link: pool.link as string | undefined,
    slug: pool.slug as string | undefined,
    match_type: pool.match_type as string | undefined,
    identification_method: pool.identification_method as ('address' | 'tag' | undefined)
  };
  
  return result;
}

/**
 * Get blocks with pagination using direct MongoDB query
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

  try {
    // If after is provided, fetch blocks after that height
    if (after !== undefined) {
      // Create a query to fetch blocks after the specified height
      // Make sure we don't include any negative heights (like -1 for being-mined)
      const query = { 
        height: { 
          $gt: after,
          $gte: 1 // Ensure we only get positive heights (exclude being-mined)
        } 
      };
      
      // Fetch the blocks
      const result = await prisma.$runCommandRaw({
        find: 'blocks',
        filter: query,
        sort: { height: 1 }, // Sort by height ascending to get the next blocks
        limit: n,
      }) as MongoDBCommandResult;
      
      if (!result || !result.cursor || !result.cursor.firstBatch) {
        console.error('Invalid response from MongoDB query:', result);
        return { blocks: [], has_more: false, next_height: null };
      }
      
      const blocks = result.cursor.firstBatch;
      
      // Process blocks to convert pool JSON to mining_pool format expected by the frontend
      const processedBlocks = blocks.map((block: MongoDBBlock) => {
        // Try to get pool data from either the 'pool' field or the 'mining_pool' field
        const poolData = block.mining_pool || block.pool;
        
        // Convert the pool data to the mining_pool format expected by the frontend
        const mining_pool = formatMiningPool(poolData);
        
        return {
          ...block,
          id: block._id?.toString ? block._id.toString() : block.id, // Convert ObjectId to string
          mining_pool,
          analysis: block.analysis
        };
      });
      
      // Sort blocks by height in ascending order first (they come from the DB this way)
      // then reverse to get them in descending order for the frontend
      const reversedBlocks = [...processedBlocks].sort((a, b) => b.height - a.height);
      
      // Return the blocks
      return {
        blocks: reversedBlocks,
        has_more: reversedBlocks.length === n, // If we got as many blocks as we asked for, there might be more
        next_height: null // Not applicable for "after" query
      };
    }
    
    // If height is provided, fetch blocks centered around that height
    if (height !== undefined) {
      // Calculate how many blocks to fetch before and after the specified height
      const halfN = Math.floor(n / 2);
      
      // Create a query to fetch blocks in the range [height - halfN, height + halfN]
      const query = { 
        height: { 
          $gte: Math.max(0, height - halfN),
          $lte: height + halfN 
        } 
      };
      
      // Fetch the blocks
      const result = await prisma.$runCommandRaw({
        find: 'blocks',
        filter: query,
        sort: { height: -1 },
        limit: n * 2, // Fetch more blocks to ensure we get enough
      }) as MongoDBCommandResult;
      
      if (!result || !result.cursor || !result.cursor.firstBatch) {
        console.error('Invalid response from MongoDB query:', result);
        return { blocks: [], has_more: false, next_height: null };
      }
      
      const blocks = result.cursor.firstBatch;
      
      // Process blocks to convert pool JSON to mining_pool format expected by the frontend
      const processedBlocks = blocks.map((block: MongoDBBlock) => {
        // Try to get pool data from either the 'pool' field or the 'mining_pool' field
        const poolData = block.mining_pool || block.pool;
        
        // Convert the pool data to the mining_pool format expected by the frontend
        const mining_pool = formatMiningPool(poolData);
        
        return {
          ...block,
          id: block._id?.toString ? block._id.toString() : block.id, // Convert ObjectId to string
          mining_pool,
          analysis: block.analysis
        };
      });
      
      // Sort blocks by height in descending order
      processedBlocks.sort((a, b) => b.height - a.height);
      
      // Check if the requested height is in the results
      const hasRequestedHeight = processedBlocks.some(block => block.height === height);
      
      // If the requested height is not in the results, we need to fetch it specifically
      if (!hasRequestedHeight) {
        const specificBlock = await getBlockByHeight(height);
        
        if (specificBlock) {
          // Add the specific block to the results - using type assertion since we know it's compatible
          // @ts-expect-error - we know this matches the structure even if TypeScript can't verify it
          processedBlocks.push(specificBlock);
          // Re-sort the blocks
          processedBlocks.sort((a, b) => b.height - a.height);
        }
      }
      
      // Return the blocks with pagination info
      // Set next_height to the lowest height we fetched minus 1
      const lowestHeight = processedBlocks.length > 0 
        ? Math.min(...processedBlocks.map(b => b.height)) 
        : null;
      
      return {
        blocks: processedBlocks,
        has_more: lowestHeight !== null && lowestHeight > 0,
        next_height: lowestHeight !== null ? lowestHeight - 1 : null
      };
    }
    
    // Use Prisma's $runCommandRaw to execute a direct MongoDB query
    // This allows us to access all fields in the document, including those not in the Prisma schema
    const query = before ? { height: { $lte: before } } : {};
    
    const result = await prisma.$runCommandRaw({
      find: 'blocks',
      filter: query,
      sort: { height: -1 },
      limit: n + 1,
    }) as MongoDBCommandResult;
    
    if (!result || !result.cursor || !result.cursor.firstBatch) {
      console.error('Invalid response from MongoDB query:', result);
      return { blocks: [], has_more: false, next_height: null };
    }
    
    const blocks = result.cursor.firstBatch;
    
    // Process blocks to convert pool JSON to mining_pool format expected by the frontend
    const processedBlocks = blocks.map((block: MongoDBBlock) => {
      // Try to get pool data from either the 'pool' field or the 'mining_pool' field
      const poolData = block.mining_pool || block.pool;
      
      // Convert the pool data to the mining_pool format expected by the frontend
      const mining_pool = formatMiningPool(poolData);
      
      return {
        ...block,
        id: block._id.toString(), // Convert ObjectId to string
        mining_pool,
        analysis: block.analysis
      };
    });
    
    // Check if we have more blocks
    const hasMore = processedBlocks.length > n;
    const result_blocks = hasMore ? processedBlocks.slice(0, n) : processedBlocks;
    
    // Return both the blocks and pagination info
    return {
      blocks: result_blocks,
      has_more: hasMore,
      next_height: result_blocks.length > 0 ? result_blocks[result_blocks.length - 1].height : null
    };
  } catch (error) {
    console.error('Error fetching blocks:', error);
    
    // Fall back to the standard Prisma query if the direct MongoDB query fails
    console.warn('Falling back to standard Prisma query');
    
    const query = before ? { height: { lte: before } } : {};
    
    const blocks = await prisma.block.findMany({
      where: query,
      orderBy: { height: 'desc' },
      take: n + 1,
      select: {
        id: true,
        height: true,
        block_hash: true,
        timestamp: true,
        coinbase_script_sig: true,
        pool: true,
        transactions: true,
        size: true,
        weight: true,
        version: true,
        merkle_root: true,
        bits: true,
        nonce: true,
        difficulty: true
      }
    });
    
    // Process blocks to convert pool JSON to mining_pool format expected by the frontend
    const processedBlocks = blocks.map(block => {
      // Try to access the raw document
      const rawBlock = block as unknown as RawDocument;
      
      // Try to get pool data from the document
      let poolData: Record<string, unknown> | null | undefined = block.pool as Record<string, unknown> | null;
      
      // If we have access to the raw document, try to get the mining_pool field
      // This is a workaround since Prisma schema doesn't have mining_pool field
      if (rawBlock._document && rawBlock._document.mining_pool) {
        poolData = rawBlock._document.mining_pool;
      }
      
      // For MongoDB driver, the field might be directly accessible
      if (rawBlock.mining_pool) {
        poolData = rawBlock.mining_pool;
      }
      
      // Convert the pool data to the mining_pool format expected by the frontend
      const mining_pool = formatMiningPool(poolData);
      
      return {
        ...block,
        mining_pool
      };
    });
    
    // Check if we have more blocks
    const hasMore = processedBlocks.length > n;
    const result = hasMore ? processedBlocks.slice(0, n) : processedBlocks;
    
    // Return both the blocks and pagination info
    return {
      blocks: result,
      has_more: hasMore,
      next_height: result.length > 0 ? result[result.length - 1].height : null
    };
  }
}

/**
 * Get a single block by height using direct MongoDB query
 * @param height Block height
 * @returns Block or null if not found
 */
export async function getBlockByHeight(height: number) {
  if (!enableHistoricalData) {
    console.log(`Historical data is disabled. Skipping fetch for block height ${height}.`);
    return null;
  }

  try {
    // Use Prisma's $runCommandRaw to execute a direct MongoDB query
    const result = await prisma.$runCommandRaw({
      find: 'blocks',
      filter: { height },
      limit: 1,
    }) as MongoDBCommandResult;
    
    if (!result || !result.cursor || !result.cursor.firstBatch || result.cursor.firstBatch.length === 0) {
      return null;
    }
    
    const block = result.cursor.firstBatch[0] as MongoDBBlock;
    
    // Try to get pool data from either the 'pool' field or the 'mining_pool' field
    const poolData = block.mining_pool || block.pool;
    
    // Convert the pool data to the mining_pool format expected by the frontend
    const mining_pool = formatMiningPool(poolData);
    
    // Helper to coerce potential ObjectId or string id without using any
    function coerceId(b: MongoDBBlock | { id?: unknown; _id?: { toString(): string } }): string {
      // Prefer _id if present
      const maybeObjId = (b as { _id?: { toString(): string } })._id;
      if (maybeObjId && typeof maybeObjId.toString === 'function') {
        return maybeObjId.toString();
      }
      const maybeId = (b as { id?: unknown }).id;
      return typeof maybeId === 'string' ? maybeId : '';
    }
    
    // Extract analysis if present on the raw object shape
    function coerceAnalysis(b: unknown): Record<string, unknown> | undefined {
      if (b && typeof b === 'object' && 'analysis' in (b as Record<string, unknown>)) {
        const a = (b as Record<string, unknown>)['analysis'];
        return (a && typeof a === 'object') ? (a as Record<string, unknown>) : undefined;
      }
      return undefined;
    }
    
    return {
      ...block,
      id: coerceId(block),
      mining_pool,
      analysis: coerceAnalysis(block)
    };
  } catch (error) {
    console.error(`Error fetching block by height ${height}:`, error);
    
    // Fall back to the standard Prisma query if the direct MongoDB query fails
    console.warn('Falling back to standard Prisma query');
    
    const block = await prisma.block.findUnique({
      where: { height },
      select: {
        id: true,
        height: true,
        block_hash: true,
        timestamp: true,
        coinbase_script_sig: true,
        pool: true,
        transactions: true,
        size: true,
        weight: true,
        version: true,
        merkle_root: true,
        bits: true,
        nonce: true,
        difficulty: true
      }
    });
    
    if (!block) return null;
    
    // Try to access the raw document
    const rawBlock = block as unknown as RawDocument;
    
    // Try to get pool data from the document
    let poolData: Record<string, unknown> | null | undefined = block.pool as Record<string, unknown> | null;
    
    // If we have access to the raw document, try to get the mining_pool field
    // This is a workaround since Prisma schema doesn't have mining_pool field
    if (rawBlock._document && rawBlock._document.mining_pool) {
      poolData = rawBlock._document.mining_pool;
    }
    
    // For MongoDB driver, the field might be directly accessible
    if (rawBlock.mining_pool) {
      poolData = rawBlock.mining_pool;
    }
    
    // Convert the pool data to the mining_pool format expected by the frontend
    const mining_pool = formatMiningPool(poolData);
    
    function coerceId2(b: MongoDBBlock | { id?: unknown; _id?: { toString(): string } }): string {
      const maybeObjId = (b as { _id?: { toString(): string } })._id;
      if (maybeObjId && typeof maybeObjId.toString === 'function') {
        return maybeObjId.toString();
      }
      const maybeId = (b as { id?: unknown }).id;
      return typeof maybeId === 'string' ? maybeId : '';
    }
    function coerceAnalysis2(b: unknown): Record<string, unknown> | undefined {
      if (b && typeof b === 'object' && 'analysis' in (b as Record<string, unknown>)) {
        const a = (b as Record<string, unknown>)['analysis'];
        return (a && typeof a === 'object') ? (a as Record<string, unknown>) : undefined;
      }
      return undefined;
    }
    
    return {
      ...block,
      id: coerceId2(block),
      mining_pool,
      analysis: coerceAnalysis2(block)
    };
  }
}

/**
 * Get a single block by hash using direct MongoDB query
 * @param blockHash Block hash
 * @returns Block or null if not found
 */
export async function getBlockByHash(blockHash: string) {
  if (!enableHistoricalData) {
    console.log(`Historical data is disabled. Skipping fetch for block hash ${blockHash}.`);
    return null;
  }

  try {
    // Use Prisma's $runCommandRaw to execute a direct MongoDB query
    const result = await prisma.$runCommandRaw({
      find: 'blocks',
      filter: { block_hash: blockHash },
      limit: 1,
    }) as MongoDBCommandResult;
    
    if (!result || !result.cursor || !result.cursor.firstBatch || result.cursor.firstBatch.length === 0) {
      return null;
    }
    
    const block = result.cursor.firstBatch[0] as MongoDBBlock;
    
    // Try to get pool data from either the 'pool' field or the 'mining_pool' field
    const poolData = block.mining_pool || block.pool;
    
    // Convert the pool data to the mining_pool format expected by the frontend
    const mining_pool = formatMiningPool(poolData);
    
    function coerceId2(b: MongoDBBlock | { id?: unknown; _id?: { toString(): string } }): string {
      const maybeObjId = (b as { _id?: { toString(): string } })._id;
      if (maybeObjId && typeof maybeObjId.toString === 'function') {
        return maybeObjId.toString();
      }
      const maybeId = (b as { id?: unknown }).id;
      return typeof maybeId === 'string' ? maybeId : '';
    }
    function coerceAnalysis2(b: unknown): Record<string, unknown> | undefined {
      if (b && typeof b === 'object' && 'analysis' in (b as Record<string, unknown>)) {
        const a = (b as Record<string, unknown>)['analysis'];
        return (a && typeof a === 'object') ? (a as Record<string, unknown>) : undefined;
      }
      return undefined;
    }
    
    return {
      ...block,
      id: coerceId2(block),
      mining_pool,
      analysis: coerceAnalysis2(block)
    };
  } catch (error) {
    console.error(`Error fetching block by hash ${blockHash}:`, error);
    
    // Fall back to the standard Prisma query if the direct MongoDB query fails
    console.warn('Falling back to standard Prisma query');
    
    const block = await prisma.block.findUnique({
      where: { block_hash: blockHash },
      select: {
        id: true,
        height: true,
        block_hash: true,
        timestamp: true,
        coinbase_script_sig: true,
        pool: true,
        transactions: true,
        size: true,
        weight: true,
        version: true,
        merkle_root: true,
        bits: true,
        nonce: true,
        difficulty: true
      }
    });
    
    if (!block) return null;
    
    // Try to access the raw document
    const rawBlock = block as unknown as RawDocument;
    
    // Try to get pool data from the document
    let poolData: Record<string, unknown> | null | undefined = block.pool as Record<string, unknown> | null;
    
    // If we have access to the raw document, try to get the mining_pool field
    // This is a workaround since Prisma schema doesn't have mining_pool field
    if (rawBlock._document && rawBlock._document.mining_pool) {
      poolData = rawBlock._document.mining_pool;
    }
    
    // For MongoDB driver, the field might be directly accessible
    if (rawBlock.mining_pool) {
      poolData = rawBlock.mining_pool;
    }
    
    // Convert the pool data to the mining_pool format expected by the frontend
    const mining_pool = formatMiningPool(poolData);
    
    function coerceId2(b: MongoDBBlock | { id?: unknown; _id?: { toString(): string } }): string {
      const maybeObjId = (b as { _id?: { toString(): string } })._id;
      if (maybeObjId && typeof maybeObjId.toString === 'function') {
        return maybeObjId.toString();
      }
      const maybeId = (b as { id?: unknown }).id;
      return typeof maybeId === 'string' ? maybeId : '';
    }
    function coerceAnalysis2(b: unknown): Record<string, unknown> | undefined {
      if (b && typeof b === 'object' && 'analysis' in (b as Record<string, unknown>)) {
        const a = (b as Record<string, unknown>)['analysis'];
        return (a && typeof a === 'object') ? (a as Record<string, unknown>) : undefined;
      }
      return undefined;
    }
    
    return {
      ...block,
      id: coerceId2(block),
      mining_pool,
      analysis: coerceAnalysis2(block)
    };
  }
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

  try {
    return prisma.block.findFirst({
      orderBy: { height: 'desc' },
    });
  } catch (error) {
    console.error('Error fetching highest block:', error);
    return null;
  }
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

  try {
    return prisma.block.findFirst({
      orderBy: { height: 'asc' },
    });
  } catch (error) {
    console.error('Error fetching lowest block:', error);
    return null;
  }
} 