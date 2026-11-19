import { NextResponse } from "next/server";
// Relative imports so the route can be unit-tested (lib/__tests__/unknownParentsRoute.test.ts)
import { enableHistoricalData } from "../../../lib/db/blocks";
import { RANGE_DAYS, UNKNOWN_PARENTS_RANGES, type UnknownParentsRange } from "../../../lib/db/unknown-parents";
import { getDrill, getEpisodes, type Drill, type Episode } from "../../../lib/unknownParents";
import { blacklistedPoolNames } from "../../../lib/poolBlacklist";

export const dynamic = "force-dynamic";

/**
 * Unknown parents: templates whose previous block is no block we know, as episodes (one per parent), each with the
 * facts its kind is inferred from (lib/unknownParents.ts, lib/parentKind.ts), over a range: the episodes whose last
 * template is in the last 90 days (default), the last year, or all history. Read-only. With historical data disabled
 * it answers enabled: false, supported: false without touching a database. POOL_BLACKLIST pools are left out
 * entirely: their templates, connections and the episodes only they built on.
 *
 *   GET /api/unknown-parents[?range=90d|1y|all]
 *       { range, days (null for all), window_start, generated_at, episodes: Episode[] } (oldest first); window_start
 *       is generated_at - days, or for all the first episode's first template (generated_at when there is none)
 *   GET /api/unknown-parents?parent=<64 hex, display order>[&range=…]
 *       one episode's drill-in: { episode, from_ms, to_ms, templates (decoded, each labelled by its parent),
 *       truncated, blocks (every block we know at height - 1 and height, with arrival) }; 404 if the parent isn't an
 *       episode of that range's summary
 *
 * The summary reads the backend's per-(parent, pool) table (a few ms); it's computed once per SUMMARY_MS per process
 * and range and served stale while a refresh runs. A drill-in is looked up in that summary (so it reads only the
 * episode's pools, heights and minutes) and cached for DRILL_MS.
 */
const SUMMARY_MS = 5 * 60_000;
const DRILL_MS = 60_000;
const DRILL_CACHE_ENTRIES = 50;

interface SummaryResponse {
  enabled: boolean;
  supported: boolean;
  range?: UnknownParentsRange;
  days?: number | null;
  window_start?: number;         // ms
  generated_at?: number;
  episodes?: Episode[];
}

interface DrillResponse extends Drill {
  enabled: true;
  supported: true;
  episode: Episode;
}

// The summary entry being served per range: `settled` once its read finished, `fallback` = the previous result,
// served while this one is still running.
interface SummaryEntry { at: number; promise: Promise<SummaryResponse>; settled: SummaryResponse | null; fallback: SummaryResponse | null }
const summaries = new Map<UnknownParentsRange, SummaryEntry>();
const drills = new Map<string, { at: number; promise: Promise<DrillResponse> }>();

function refreshSummary(range: UnknownParentsRange, now: number, fallback: SummaryResponse | null): SummaryEntry {
  const entry: SummaryEntry = {
    at: now, settled: null, fallback,
    promise: getEpisodes(blacklistedPoolNames(), range).then(episodes => {
      const generated_at = Date.now();
      const days = RANGE_DAYS[range];
      const window_start = days !== null ? generated_at - days * 86_400_000
        : episodes.reduce((m, e) => Math.min(m, e.first_ms), generated_at);
      return { enabled: true, supported: true, range, days, window_start, generated_at, episodes };
    }),
  };
  entry.promise.then(r => { entry.settled = r; }, () => {
    // Don't keep a failure: serve the previous result (if any) as stale, so the next request retries.
    if (summaries.get(range) !== entry) return;
    if (fallback) summaries.set(range, { at: 0, promise: Promise.resolve(fallback), settled: fallback, fallback: null });
    else summaries.delete(range);
  });
  summaries.set(range, entry);
  return entry;
}

async function getSummary(range: UnknownParentsRange): Promise<SummaryResponse> {
  const now = Date.now();
  const current = summaries.get(range);
  // Stale (or none yet): start one refresh, and serve the last good result meanwhile.
  const entry = !current || now - current.at > SUMMARY_MS
    ? refreshSummary(range, now, current?.settled ?? current?.fallback ?? null) : current;
  return entry.settled ?? entry.fallback ?? entry.promise;
}

const PARENT_RE = /^[0-9a-f]{64}$/;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (!enableHistoricalData) return NextResponse.json({ enabled: false, supported: false });

  const range = (params.get("range") ?? "90d") as UnknownParentsRange;
  if (!UNKNOWN_PARENTS_RANGES.includes(range)) {
    return NextResponse.json({ error: `range must be one of ${UNKNOWN_PARENTS_RANGES.join(", ")}` }, { status: 400 });
  }
  const parent = params.get("parent");
  try {
    if (parent === null) {
      return NextResponse.json(await getSummary(range), { headers: { "Cache-Control": "public, max-age=60" } });
    }
    const p = parent.toLowerCase();
    if (!PARENT_RE.test(p)) return NextResponse.json({ error: "parent must be 64 hex characters" }, { status: 400 });
    const episode = (await getSummary(range)).episodes?.find(e => e.parent === p);
    if (!episode) return NextResponse.json({ error: "no such episode in this range" }, { status: 404 });

    const now = Date.now();
    const key = `${range}:${p}`;
    let entry = drills.get(key);
    if (!entry || now - entry.at > DRILL_MS) {
      const promise = getDrill(episode, blacklistedPoolNames())
        .then((d): DrillResponse => ({ enabled: true, supported: true, episode, ...d }));
      entry = { at: now, promise };
      drills.delete(key);
      drills.set(key, entry);
      while (drills.size > DRILL_CACHE_ENTRIES) drills.delete(drills.keys().next().value as string);
      promise.catch(() => { if (drills.get(key)?.promise === promise) drills.delete(key); });
    }
    return NextResponse.json(await entry.promise, { headers: { "Cache-Control": "public, max-age=60" } });
  } catch (error: unknown) {
    console.error("Error reading unknown parents:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
