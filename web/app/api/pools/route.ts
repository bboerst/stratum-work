import { NextResponse } from 'next/server';
import { getAllPools } from '@/lib/db/pools';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const pools = await getAllPools();
    return NextResponse.json(pools);
  } catch (error: Error | unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Server error', details: errorMessage },
      { status: 500 }
    );
  }
} 