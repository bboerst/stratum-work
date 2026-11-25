import { NextResponse } from "next/server";
// Relative imports, like the other routes, so it can be unit-tested
import { enableHistoricalData, getHighestBlock } from "../../../lib/db/blocks";
import { getFirstLatencies, getMatchBlocks, getMatchRows } from "../../../lib/db/block-template-matches";
import { blockMatches, type BlockMatches } from "../../../lib/blockTemplateMatches";
import { filterBlacklistedAboveTip } from "../../../lib/poolBlacklist";

export const dynamic = "force-dynamic";

/**
 * Which stored templates each block at a height was built from (#235; lib/blockTemplateMatches.ts):
 *
 *   GET /api/block-template-matches?height=<h>
 *       { height, blocks: BlockMatches[] }: per block at h on our best chain, its state (verified / empty_block /
 *       no_match / unknown), every verified match (pool, connection, first receive time with that copy's own latency
 *       estimate, templates, coinbase fit) and, without one, how far the closest transaction set agreed.
 *
 * No job ids and no template bytes. A block is at or below our tip, so POOL_BLACKLIST pools stay in (analysis, not
 * live work; filterBlacklistedAboveTip). A height whose block is stored can still change (the backend fills a block's
 * merkle path and coinbase later), so it is kept CACHE_MS; at most CACHE_ENTRIES heights; one read per height at a time.
 */
const CACHE_MS = 5 * 60_000;
const CACHE_ENTRIES = 300;
type Body = { height: number; blocks: BlockMatches[] };
const store = globalThis as { __blockTemplateMatches?: Map<number, { at: number; promise: Promise<Body> }> };
const cache = (store.__blockTemplateMatches ??= new Map());

async function read(height: number): Promise<Body> {
  const [blocks, rows, tip] = await Promise.all([
    getMatchBlocks(height), getMatchRows(height), getHighestBlock().then(b => b?.height ?? null),
  ]);
  const shown = filterBlacklistedAboveTip(rows, height, tip, r => r.pool);
  const firsts = shown.filter(r => r.full_match).map(r => ({ source_id: r.source_id, first_us: r.first_us }));
  const latencies = await getFirstLatencies(height, firsts);
  return { height, blocks: blockMatches(blocks, shown, latencies) };
}

export async function GET(request: Request) {
  if (!enableHistoricalData) return NextResponse.json({ enabled: false });
  const raw = new URL(request.url).searchParams.get("height") ?? "";
  if (!/^[1-9][0-9]{0,8}$/.test(raw)) return NextResponse.json({ error: "height must be a positive integer" }, { status: 400 });
  const height = Number(raw);
  const now = Date.now();
  let entry = cache.get(height);
  if (!entry || now - entry.at > CACHE_MS) {
    const promise = read(height);
    entry = { at: now, promise };
    cache.delete(height);
    cache.set(height, entry);
    while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as number);
    promise.catch(() => { if (cache.get(height)?.promise === promise) cache.delete(height); });
  }
  try {
    return NextResponse.json(await entry.promise, { headers: { "Cache-Control": "public, max-age=60" } });
  } catch (error: unknown) {
    console.error(`Error reading block template matches at ${height}:`, error);
    return NextResponse.json({ error: "Failed to read template matches" }, { status: 500 });
  }
}
