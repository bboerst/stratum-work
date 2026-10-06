import { NextResponse } from 'next/server';
import { enableHistoricalData } from '@/lib/db/blocks';
import { getBlockPoolFirstSeen } from '@/lib/db/mining-notify';
import { filterBlacklistedItems } from '@/lib/poolBlacklist';

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
    const data = filterBlacklistedItems(await getBlockPoolFirstSeen(height), d => d.poolName);
    return NextResponse.json(data);
  } catch (error) {
    console.error(`Error fetching first seen pool data for height ${height}:`, error);
    return NextResponse.json({ error: 'Failed to fetch data' }, { status: 500 });
  }
}
