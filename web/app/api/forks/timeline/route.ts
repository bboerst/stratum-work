import { NextResponse } from "next/server";
// Relative imports, like the other routes, so it can be unit-tested
import { enableHistoricalData } from "../../../../lib/db/blocks";
import { getForkLanes, type ForkLanes } from "../../../../lib/forkLanes";
import { getSummary } from "../../../../lib/forksSummary";
import { realtimeExclusion } from "../../../../lib/poolBlacklist";
import { isHeightFinal } from "../../../../lib/db/mining-notify";

export const dynamic = "force-dynamic";

/**
 * One height's fork timeline for the Forks page (lib/forkLanes.ts): per pool, runs of work on each parent, invalid work
 * marked by the height's stored finding, and the blocks at height - 1 and height.
 *
 *   GET /api/forks/timeline?height=<h>
 *       ForkLanes; 404 unless an episode in all history claims that height (other chains' episodes excepted: their
 *       heights aren't ours), so the route reads only the windows the Forks page shows.
 *
 * The read covers the height's receive window widened to its episodes. POOL_BLACKLIST is realtime-only, as in
 * /api/forks: an excluded pool is shown at heights at or below our tip, and left out of any read above it. Kept per height for CACHE_MS once its receive window has closed, OPEN_MS before; at most CACHE_ENTRIES
 * heights (a few KB each); one read per height at a time however many viewers ask.
 */
const CACHE_MS = 10 * 60_000;      // a height whose receive window has closed (nothing more can arrive)
const OPEN_MS = 30_000;            // one still open (a race happening now, or minutes ago)
const CACHE_ENTRIES = 300;
const store = globalThis as { __forkLanes?: Map<number, { at: number; ttl: number; promise: Promise<ForkLanes> }> };
const cache = (store.__forkLanes ??= new Map());
type Entry = { at: number; ttl: number; promise: Promise<ForkLanes> };

export async function GET(request: Request) {
  if (!enableHistoricalData) return NextResponse.json({ enabled: false, supported: false });
  const raw = new URL(request.url).searchParams.get("height") ?? "";
  if (!/^[1-9][0-9]{0,8}$/.test(raw)) return NextResponse.json({ error: "height must be a positive integer" }, { status: 400 });
  const height = Number(raw);
  try {
    const summary = await getSummary("all-lite");
    const episodes = (summary.episodes ?? [])
      .filter(e => e.kind !== "other_chain" && (e.heights?.length ? e.heights : [e.height]).includes(height));
    if (episodes.length === 0) return NextResponse.json({ error: "no fork at this height" }, { status: 404 });
    const span = { fromMs: Math.min(...episodes.map(e => e.first_ms)), toMs: Math.max(...episodes.map(e => e.last_ms)) };

    const now = Date.now();
    let entry: Entry | undefined = cache.get(height);
    if (!entry || now - entry.at > entry.ttl) {
      // the summary's tip (never ahead of ours): an excluded pool's work above it stays out
      const promise = getForkLanes(height, span, realtimeExclusion(summary.tip_height));
      promise.catch(() => {});           // handled below; read alongside isHeightFinal
      const final = await isHeightFinal(height).catch(() => false);
      entry = { at: now, ttl: final ? CACHE_MS : OPEN_MS, promise };
      cache.delete(height);
      cache.set(height, entry);
      while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as number);
      promise.catch(() => { if (cache.get(height)?.promise === promise) cache.delete(height); });
    }
    return NextResponse.json(await entry.promise,
      { headers: { "Cache-Control": `public, max-age=${entry.ttl === CACHE_MS ? 300 : 15}` } });
  } catch (error: unknown) {
    console.error("Error reading a fork timeline:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
