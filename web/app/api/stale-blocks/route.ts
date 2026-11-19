import { NextResponse } from "next/server";
// Relative imports so the route can be unit-tested (lib/__tests__/staleBlocksRoute.test.ts)
import { enableHistoricalData, getHighestBlock } from "../../../lib/db/blocks";
import { getRecentStaleBlocks, STALE_BLOCKS_MAX, type StaleBlock } from "../../../lib/db/stale-blocks";
import { filterBlacklistedAboveTip } from "../../../lib/poolBlacklist";

export const dynamic = "force-dynamic";

/**
 * Recent stale (orphaned) blocks the node saw, each with the pools that built templates on it: how many templates,
 * first / last receive time, and how long after our node moved on (#180). Read-only. With historical data disabled
 * it answers enabled: false, supported: false without touching a database.
 *
 *   GET /api/stale-blocks?n=20   (1..100)
 *
 * Every visitor asks for the same few things and stale blocks are rare, so each response is shared for CACHE_MS.
 * Template summaries at a height above the chain tip are current work, so POOL_BLACKLIST applies to them (like the
 * template reads); older ones are history and stay.
 */
const CACHE_MS = 30_000;

interface StaleBlocksResponse {
  enabled: boolean;
  supported: boolean;
  tip: number | null;
  stale_blocks: StaleBlock[];
}

const cache = new Map<number, { at: number; promise: Promise<StaleBlocksResponse> }>();

async function build(n: number): Promise<StaleBlocksResponse> {
  if (!enableHistoricalData) return { enabled: false, supported: false, tip: null, stale_blocks: [] };
  const [blocks, highest] = await Promise.all([getRecentStaleBlocks(n), getHighestBlock()]);
  const tip = highest ? Number(highest.height) : null;
  return {
    enabled: true, supported: true, tip,
    stale_blocks: blocks.map(b => ({
      ...b,
      templates: b.templates.length ? filterBlacklistedAboveTip(b.templates, b.height + 1, tip, t => t.pool) : b.templates,
    })),
  };
}

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("n");
  const parsed = raw === null ? 20 : parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return NextResponse.json({ error: "n must be a positive integer" }, { status: 400 });
  }
  const n = Math.min(parsed, STALE_BLOCKS_MAX);

  const now = Date.now();
  let entry = cache.get(n);
  if (!entry || now - entry.at > CACHE_MS) {
    const promise = build(n);
    entry = { at: now, promise };
    cache.set(n, entry);
    // Don't keep serving a failure for the whole cache period.
    promise.catch(() => {
      if (cache.get(n)?.promise === promise) cache.delete(n);
    });
  }

  try {
    return NextResponse.json(await entry.promise, { headers: { "Cache-Control": "no-store" } });
  } catch (error: unknown) {
    console.error("Error reading stale blocks:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
