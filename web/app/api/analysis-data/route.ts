import { NextRequest, NextResponse } from "next/server";
import { getMiningNotifyByHeight } from "@/lib/db/mining-notify";
import { getBlockByHeight } from "@/lib/db/blocks";
import { prisma } from "@/lib/db/prisma";

interface InterestingBlockItem {
  height: number;
  block_hash: string;
  analysis?: Record<string, unknown>;
  mining_pool?: Record<string, unknown>;
}

interface MongoCursorResult<T> {
  cursor: { firstBatch: T[] };
}
import { formatCoinbaseRaw, reverseHex } from "@/utils/formatters";
import { 
  formatCoinbaseScriptASCII, 
  computeCoinbaseOutputValue, 
  computeFirstTransaction, 
  computeCoinbaseOutputs 
} from "@/utils/bitcoinUtils";

/**
 * API endpoint that returns Bitcoin mining data with all computed values for analysis
 * 
 * This endpoint returns all the original stratum v1 messages along with
 * additional decoded fields that are computed in the client application.
 * It also includes block details for the requested height(s) and the previous height.
 * 
 * Query parameters:
 * - height: Single block height or comma-separated list of heights
 * 
 * Example usage:
 * - /api/analysis-data?height=800000
 * - /api/analysis-data?height=800000,800001,800002
 * 
 * Response format:
 * {
 *   "results": [
 *     {
 *       "height": 800000,
 *       "mining_notifications": [...],
 *       "block_details": {...},
 *       "previous_block": {...}
 *     },
 *     ...
 *   ]
 * }
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const heightParam = searchParams.get('height');
  const interesting = searchParams.get('interesting');
  
  // If interesting=true, return a list of interesting blocks (excluding pool_identification-only)
  if (interesting === 'true') {
    try {
      const raw = await prisma.$runCommandRaw({
        find: 'blocks',
        filter: {
          analysis: { $exists: true, $type: 'object' },
          $expr: {
            $gt: [
              {
                $size: {
                  $filter: {
                    input: { $objectToArray: '$analysis' },
                    as: 'kv',
                    cond: { $ne: ['$$kv.k', 'pool_identification'] }
                  }
                }
              },
              0
            ]
          }
        },
        projection: { _id: 0, height: 1, block_hash: 1, analysis: 1, mining_pool: 1 },
        sort: { height: -1 },
        limit: 200
      }) as unknown as MongoCursorResult<InterestingBlockItem>;
      const items: InterestingBlockItem[] = raw?.cursor?.firstBatch || [];
      return NextResponse.json({ items });
    } catch (e) {
      console.error('Error fetching interesting blocks:', e);
      return NextResponse.json({ items: [] });
    }
  }

  if (!heightParam) {
    return NextResponse.json({ error: "Missing block height" }, { status: 400 });
  }
  
  try {
    // Parse heights (single height or comma-separated list)
    const heights = heightParam.split(',').map(h => parseInt(h.trim())).filter(h => !isNaN(h));
    
    if (heights.length === 0) {
      return NextResponse.json({ error: "Invalid block height" }, { status: 400 });
    }
    
    // Process each height in parallel
    const results = await Promise.all(heights.map(async (height) => {
      // Fetch mining notifications for the requested height
      const miningNotifications = await getMiningNotifyByHeight(height);
      
      // Fetch block details for the requested height and previous height
      const currentBlock = await getBlockByHeight(height);
      const previousBlock = await getBlockByHeight(height - 1);
      
      // Process the mining notifications to include all decoded fields
      const processedData = miningNotifications.map(notification => {
        // Reconstruct the coinbase transaction
        const coinbaseRaw = formatCoinbaseRaw(
          notification.coinbase1,
          notification.extranonce1,
          notification.extranonce2_length,
          notification.coinbase2
        );
        
        // Compute all the derived fields
        const coinbaseScriptASCII = formatCoinbaseScriptASCII(coinbaseRaw);
        const coinbaseOutputValue = computeCoinbaseOutputValue(coinbaseRaw);
        const firstTransaction = computeFirstTransaction(notification.merkle_branches);
        const coinbaseOutputs = computeCoinbaseOutputs(coinbaseRaw);
        
        // Handle prev_hash endianness - use only the reversed (big-endian) format
        const prevHash = reverseHex(notification.prev_hash);
        
        // Return the original notification with the additional computed fields
        return {
          // Original fields from the notification (excluding coinbase1 and coinbase2)
          id: notification.id,
          pool_name: notification.pool_name,
          timestamp: notification.timestamp,
          height: notification.height,
          prev_hash: prevHash, // Use only the reversed (big-endian) format
          merkle_branches: notification.merkle_branches,
          version: notification.version,
          nbits: notification.nbits,
          ntime: notification.ntime,
          clean_jobs: notification.clean_jobs,
          extranonce1: notification.extranonce1,
          extranonce2_length: notification.extranonce2_length,
          
          // Computed fields
          coinbaseRaw,
          coinbaseScriptASCII,
          coinbaseOutputValue,
          first_transaction: firstTransaction,
          coinbase_outputs: coinbaseOutputs,
        };
      });
      
      // Return the result for this height
      return {
        height,
        mining_notifications: processedData,
        block_details: currentBlock ? {
          height: currentBlock.height,
          hash: currentBlock.block_hash,
          timestamp: currentBlock.timestamp,
          mining_pool: currentBlock.mining_pool,
          size: currentBlock.size,
          weight: currentBlock.weight,
          version: currentBlock.version,
          merkle_root: currentBlock.merkle_root,
          bits: currentBlock.bits,
          nonce: currentBlock.nonce,
          difficulty: currentBlock.difficulty,
          transaction_count: currentBlock.transactions
        } : null,
        previous_block: previousBlock ? {
          height: previousBlock.height,
          hash: previousBlock.block_hash,
          timestamp: previousBlock.timestamp,
          mining_pool: previousBlock.mining_pool
        } : null,
      };
    }));
    
    // Return all results
    return NextResponse.json({ results });
  } catch (error: Error | unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error in analysis-data API:', error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
} 