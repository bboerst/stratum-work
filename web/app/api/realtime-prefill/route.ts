import { NextResponse } from "next/server";
// Relative imports so the route can be unit-tested (lib/__tests__/realtimePrefillRoute.test.ts)
import { enableHistoricalData, getHighestBlock } from "../../../lib/db/blocks";
import { fetchMiningNotifyByHeight } from "../../../lib/db/mining-notify";
import { isPoolBlacklisted } from "../../../lib/poolBlacklist";
import { prefillHeights, selectPrefillTemplates } from "../../../lib/prefill";

export const dynamic = "force-dynamic";

/**
 * Recent templates for the realtime visuals (#130), in one request: the Bitcoin tip from `blocks` (never the max
 * template height, see CLAUDE.md "Data gotchas") and the templates at tip + 1 (and the tip while it's recent),
 * trimmed by selectPrefillTemplates. Every visitor asks for the same thing, so the response is shared for a few
 * seconds: that bounds database reads to one pre-fill per CACHE_MS however many people open the page.
 */
const CACHE_MS = 5_000;

interface PrefillResponse {
  enabled: boolean;
  tip: { height: number; timestamp: number } | null;
  heights: number[];
  templates: unknown[];
}

let cached: { at: number; promise: Promise<PrefillResponse> } | null = null;

async function buildPrefill(nowMs: number): Promise<PrefillResponse> {
  if (!enableHistoricalData) return { enabled: false, tip: null, heights: [], templates: [] };

  const highest = await getHighestBlock();
  if (!highest) return { enabled: true, tip: null, heights: [], templates: [] };

  const tip = { height: Number(highest.height), timestamp: Number(highest.timestamp) };
  const heights = prefillHeights(tip, nowMs);
  const records = (await Promise.all(heights.map(h => fetchMiningNotifyByHeight(h)))).flat();
  const templates = selectPrefillTemplates(records, { nowMs, isBlacklisted: isPoolBlacklisted });
  return { enabled: true, tip, heights, templates };
}

export async function GET() {
  const now = Date.now();
  if (!cached || now - cached.at > CACHE_MS) {
    const promise = buildPrefill(now);
    cached = { at: now, promise };
    // Don't keep serving a failure for the whole cache period.
    promise.catch(() => {
      if (cached?.promise === promise) cached = null;
    });
  }

  try {
    const body = await cached.promise;
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error: unknown) {
    console.error("Error building realtime pre-fill:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
