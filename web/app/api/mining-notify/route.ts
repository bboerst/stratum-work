import { NextRequest, NextResponse } from "next/server";
import { getMiningNotifyByHeight } from "@/lib/db/mining-notify";
import { maskTemplates } from "@/lib/connectionMask";
import { enableHistoricalData, getHighestBlock } from "@/lib/db/blocks";
import { filterBlacklistedAboveTip } from "@/lib/poolBlacklist";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const height = searchParams.get('height');

  if (!height) {
    return NextResponse.json({ error: "Missing block height" }, { status: 400 });
  }

  try {
    const h = parseInt(height);
    // POOL_BLACKLIST hides live work only: templates above the tip (the work being handed out now) are filtered, a
    // mined height keeps every pool (analysis), as /api/analysis-data does. No tip known: filtered (fail closed).
    const [records, tip] = await Promise.all([
      getMiningNotifyByHeight(h),
      enableHistoricalData ? getHighestBlock().then(b => b?.height ?? null) : Promise.resolve(null),
    ]);
    // extranonce1 identifies the collector's connection: served masked (#105).
    const filtered = maskTemplates(filterBlacklistedAboveTip(records, h, tip, r => r.pool_name));
    
    return NextResponse.json(filtered);
  } catch (error: Error | unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
} 