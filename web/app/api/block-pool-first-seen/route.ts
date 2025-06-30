import { NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { enableHistoricalData } from '@/lib/db/blocks';

// Define the shape of the data returned by the aggregation
interface PoolFirstSeenData {
  poolName: string;
  firstSeenTimestamp: string;
}

// Minimal interface for the expected aggregation result structure
interface AggregationResult {
  cursor: {
    firstBatch: Array<PoolFirstSeenData>;
  };
  ok: number;
}

export async function GET(request: Request) {
  if (!enableHistoricalData) {
    return NextResponse.json({ error: 'Historical data is disabled.' }, { status: 503 });
  }

  const { searchParams } = new URL(request.url);
  const heightParam = searchParams.get('height');

  if (!heightParam) {
    return NextResponse.json({ error: 'Missing height parameter' }, { status: 400 });
  }

  const height = parseInt(heightParam, 10);

  if (isNaN(height) || height <= 0) {
    return NextResponse.json({ error: 'Invalid height parameter' }, { status: 400 });
  }

  try {
    const rawResult = await prisma.$runCommandRaw({
      aggregate: 'mining_notify', // The collection name for MiningNotify
      pipeline: [
        {
          $match: {
            height: height,
            $and: [
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
            firstSeenTimestamp: { $first: "$timestamp" }
          }
        },
        {
          $project: {
            _id: 0,
            poolName: "$_id",
            firstSeenTimestamp: 1
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
      const data = result.cursor.firstBatch;
      return NextResponse.json(data);
    } else {
      console.error("Unexpected MongoDB aggregation response structure:", result);
      return NextResponse.json([]); 
    }

  } catch (error) {
    console.error(`Error fetching first seen pool data for height ${height}:`, error);
    return NextResponse.json({ error: 'Failed to fetch data' }, { status: 500 });
  }
} 