import { NextRequest, NextResponse } from "next/server";
import { getMiningNotifyByHeight } from "@/lib/db/mining-notify";
import { maskTemplates } from "@/lib/connectionMask";
import { filterBlacklistedItems } from "@/lib/poolBlacklist";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const height = searchParams.get('height');

  if (!height) {
    return NextResponse.json({ error: "Missing block height" }, { status: 400 });
  }

  try {
    const h = parseInt(height);
    // The height page's template table: every template in full (job id, coinbase, merkle branches), as the realtime
    // table shows them. POOL_BLACKLIST pools are left out at every height, as in the stream (#301); the analysis views
    // (first seen, /api/analysis-data, Forks) keep them at mined heights.
    const records = await getMiningNotifyByHeight(h);
    // extranonce1 identifies the collector's connection: served masked (#105).
    const filtered = maskTemplates(filterBlacklistedItems(records, r => r.pool_name));
    
    return NextResponse.json(filtered);
  } catch (error: Error | unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
