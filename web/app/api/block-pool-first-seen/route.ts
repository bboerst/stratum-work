import { NextResponse } from 'next/server';
import { enableHistoricalData, getHighestBlock } from '@/lib/db/blocks';
import { getFirstSeenByPool, getPoolNamesAtHeight } from '@/lib/db/mining-notify';
import { filterBlacklistedAboveTip } from '@/lib/poolBlacklist';
import { markFirstSeenReliability } from '@/utils/poolTiming';

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
    const [firstSeen, tip] = await Promise.all([getFirstSeenByPool(height), getHighestBlock().then(b => b?.height ?? null)]);

    if (firstSeen) {
      // A pool's first-seen at this height is only trustworthy if we also collected a template from it at the
      // previous height (its collector was connected before this height began). See #104.
      const poolsAtPreviousHeight = await getPoolNamesAtHeight(height - 1);

      const data = markFirstSeenReliability(
        // POOL_BLACKLIST hides live work only: kept at a mined height (analysis), filtered above the tip
        filterBlacklistedAboveTip(firstSeen, height, tip, d => d.poolName),
        poolsAtPreviousHeight,
      );
      return NextResponse.json(data);
    } else {
      return NextResponse.json([]);
    }

  } catch (error) {
    console.error(`Error fetching first seen pool data for height ${height}:`, error);
    return NextResponse.json({ error: 'Failed to fetch data' }, { status: 500 });
  }
} 
