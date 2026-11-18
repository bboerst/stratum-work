import { NextResponse } from "next/server";
// Relative imports so the route can be unit-tested (lib/__tests__/unknownParentsRoute.test.ts)
import { enableHistoricalData } from "../../../lib/db/blocks";
import { UNKNOWN_PARENTS_DAYS } from "../../../lib/db/unknown-parents";
import { getDrill, getEpisodes, type Drill, type Episode } from "../../../lib/unknownParents";
import { blacklistedPoolNames } from "../../../lib/poolBlacklist";

export const dynamic = "force-dynamic";

/**
 * Unknown parents: templates of the last 90 days whose previous block is no block we know, as episodes (one per
 * parent), each with the facts its kind is inferred from (lib/unknownParents.ts, lib/parentKind.ts). Read-only. With
 * historical data disabled it answers enabled: false, supported: false without touching a database. POOL_BLACKLIST
 * pools are left out entirely: their templates, connections and the episodes only they built on.
 *
 *   GET /api/unknown-parents
 *       { days, window_start, generated_at, episodes: Episode[] } (oldest first)
 *   GET /api/unknown-parents?parent=<64 hex, display order>
 *       one episode's drill-in: { episode, from_ms, to_ms, templates (decoded, each labelled by its parent),
 *       truncated, blocks (every block we know at height - 1 and height, with arrival) }; 404 if the parent isn't an
 *       episode of the current summary
 *
 * The summary reads every template of the window (seconds on a large table), so it's computed once per SUMMARY_MS
 * per process and served stale while a refresh runs. A drill-in is looked up in that summary (so it reads only the
 * episode's pools, heights and minutes) and cached for DRILL_MS.
 */
const SUMMARY_MS = 30 * 60_000;
const DRILL_MS = 60_000;
const DRILL_CACHE_ENTRIES = 50;

interface SummaryResponse {
  enabled: boolean;
  supported: boolean;
  days?: number;
  window_start?: number;         // ms: generated_at - days
  generated_at?: number;
  episodes?: Episode[];
}

interface DrillResponse extends Drill {
  enabled: true;
  supported: true;
  episode: Episode;
}

// The summary entry being served: `settled` once its read finished, `fallback` = the previous result, served while
// this one is still running.
interface SummaryEntry { at: number; promise: Promise<SummaryResponse>; settled: SummaryResponse | null; fallback: SummaryResponse | null }
let summary: SummaryEntry | null = null;
const drills = new Map<string, { at: number; promise: Promise<DrillResponse> }>();

function refreshSummary(now: number, fallback: SummaryResponse | null): SummaryEntry {
  const entry: SummaryEntry = {
    at: now, settled: null, fallback,
    promise: getEpisodes(blacklistedPoolNames()).then(episodes => {
      const generated_at = Date.now();
      return {
        enabled: true, supported: true, days: UNKNOWN_PARENTS_DAYS,
        window_start: generated_at - UNKNOWN_PARENTS_DAYS * 86_400_000, generated_at, episodes,
      };
    }),
  };
  entry.promise.then(r => { entry.settled = r; }, () => {
    // Don't keep a failure: serve the previous result (if any) as stale, so the next request retries.
    if (summary === entry) summary = fallback ? { at: 0, promise: Promise.resolve(fallback), settled: fallback, fallback: null } : null;
  });
  summary = entry;
  return entry;
}

async function getSummary(): Promise<SummaryResponse> {
  const now = Date.now();
  if (!summary || now - summary.at > SUMMARY_MS) {
    // Stale (or none yet): start one refresh, and serve the last good result meanwhile.
    refreshSummary(now, summary?.settled ?? summary?.fallback ?? null);
  }
  const entry = summary!;
  return entry.settled ?? entry.fallback ?? entry.promise;
}

const PARENT_RE = /^[0-9a-f]{64}$/;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (!enableHistoricalData) return NextResponse.json({ enabled: false, supported: false });

  const parent = params.get("parent");
  try {
    if (parent === null) {
      return NextResponse.json(await getSummary(), { headers: { "Cache-Control": "public, max-age=60" } });
    }
    const p = parent.toLowerCase();
    if (!PARENT_RE.test(p)) return NextResponse.json({ error: "parent must be 64 hex characters" }, { status: 400 });
    const episode = (await getSummary()).episodes?.find(e => e.parent === p);
    if (!episode) return NextResponse.json({ error: "no such episode in the last 90 days" }, { status: 404 });

    const now = Date.now();
    let entry = drills.get(p);
    if (!entry || now - entry.at > DRILL_MS) {
      const promise = getDrill(episode, blacklistedPoolNames())
        .then((d): DrillResponse => ({ enabled: true, supported: true, episode, ...d }));
      entry = { at: now, promise };
      drills.delete(p);
      drills.set(p, entry);
      while (drills.size > DRILL_CACHE_ENTRIES) drills.delete(drills.keys().next().value as string);
      promise.catch(() => { if (drills.get(p)?.promise === promise) drills.delete(p); });
    }
    return NextResponse.json(await entry.promise, { headers: { "Cache-Control": "public, max-age=60" } });
  } catch (error: unknown) {
    console.error("Error reading unknown parents:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
