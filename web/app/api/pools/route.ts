import { NextResponse } from 'next/server';
import { getAllPools } from '@/lib/db/pools';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Pool definitions (names, coinbase tags) are reference data, not live work: every pool, POOL_BLACKLIST or not
    return NextResponse.json(await getAllPools());
  } catch (error: Error | unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Server error', details: errorMessage },
      { status: 500 }
    );
  }
} 