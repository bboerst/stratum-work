import { NextRequest, NextResponse } from "next/server";
import { getMiningNotifyByHeight } from "@/lib/db/mining-notify";
import { filterBlacklistedItems } from "@/lib/poolBlacklist";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const height = searchParams.get('height');

  if (!height) {
    return NextResponse.json({ error: "Missing block height" }, { status: 400 });
  }

  try {
    const records = await getMiningNotifyByHeight(parseInt(height));
    const filtered = filterBlacklistedItems(records, r => r.pool_name);
    
    return NextResponse.json(filtered);
  } catch (error: Error | unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
} 