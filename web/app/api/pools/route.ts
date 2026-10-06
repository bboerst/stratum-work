import { NextResponse } from 'next/server';
import { getPoolDefs } from '@/lib/db/pools';
import { filterBlacklistedItems } from "@/lib/poolBlacklist";

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const pools = await getPoolDefs();
    const filtered = filterBlacklistedItems(pools, p => p.name);
    return NextResponse.json(filtered);
  } catch (error: Error | unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Server error', details: errorMessage },
      { status: 500 }
    );
  }
} 