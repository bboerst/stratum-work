// Relative imports so the route and pages using it can be unit-tested (lib/__tests__/forksRoute.test.ts)
import { enableHistoricalData } from "./db/blocks";
import { RANGE_BLOCKS, getBestTipHeight, type UnknownParentsRange } from "./db/unknown-parents";
import { getEpisodes, type Episode } from "./unknownParents";
import { blacklistedPoolNames } from "./poolBlacklist";

/**
 * The Forks summary per range, shared by /api/forks and the Forks pages (short links, link previews, the preview
 * image): computed once per SUMMARY_MS per process and range, and served stale while a refresh runs. POOL_BLACKLIST
 * pools are left out of every read.
 */
export const SUMMARY_MS = 5 * 60_000;

export interface SummaryResponse {
  enabled: boolean;
  supported: boolean;
  range?: UnknownParentsRange;
  blocks?: number | null;
  tip_height?: number | null;
  from_height?: number | null;
  generated_at?: number;         // ms
  before_first_block?: number;   // episodes that began before our first stored block: not shown
  episodes?: Episode[];
}

// The summary entry being served per range: `settled` once its read finished, `fallback` = the previous result,
// served while this one is still running.
interface SummaryEntry { at: number; promise: Promise<SummaryResponse>; settled: SummaryResponse | null; fallback: SummaryResponse | null }
const summaries = new Map<UnknownParentsRange, SummaryEntry>();

function refreshSummary(range: UnknownParentsRange, now: number, fallback: SummaryResponse | null): SummaryEntry {
  const entry: SummaryEntry = {
    at: now, settled: null, fallback,
    promise: Promise.all([getEpisodes(blacklistedPoolNames(), range), getBestTipHeight()]).then(([all, tip_height]) => {
      // Episodes that began before our first stored block have no Bitcoin position and no facts to judge them by
      // (collection started mid-height): not shown, and counted in the response.
      const episodes = all.filter(e => e.facts.tip_at_first !== null);
      const before_first_block = all.length - episodes.length;
      const blocks = RANGE_BLOCKS[range];
      const from_height = tip_height === null ? null : blocks !== null ? tip_height - blocks
        : episodes.reduce((m, e) => (e.facts.tip_at_first === null ? m : Math.min(m, e.facts.tip_at_first)), tip_height);
      return { enabled: true, supported: true, range, blocks, tip_height, from_height, generated_at: Date.now(), before_first_block, episodes };
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

/** The range's summary (callers check enableHistoricalData first: this reads the database). */
export async function getSummary(range: UnknownParentsRange): Promise<SummaryResponse> {
  const now = Date.now();
  const current = summaries.get(range);
  // Stale (or none yet): start one refresh, and serve the last good result meanwhile.
  const entry = !current || now - current.at > SUMMARY_MS
    ? refreshSummary(range, now, current?.settled ?? current?.fallback ?? null) : current;
  return entry.settled ?? entry.fallback ?? entry.promise;
}

/**
 * The range's episodes for the pages, or null when there are none to read: historical data disabled (no database
 * touched) or the read failed (logged; a page then renders without its episode rather than failing).
 */
export async function loadEpisodes(range: UnknownParentsRange): Promise<Episode[] | null> {
  if (!enableHistoricalData) return null;
  try {
    return (await getSummary(range)).episodes ?? null;
  } catch (error) {
    console.error("Error reading forks:", error);
    return null;
  }
}
