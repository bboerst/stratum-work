// Relative imports so the route and pages using it can be unit-tested (lib/__tests__/forksRoute.test.ts)
import { enableHistoricalData } from "./db/blocks";
import {
  RANGE_BLOCKS, getBestTipHeight, getDrillBlocks, getParentVersions, type DrillBlockRow, type UnknownParentsRange,
} from "./db/unknown-parents";
import { getEpisodes, type Episode } from "./unknownParents";
import { excludedAt, realtimeExclusion, type RealtimeExclusion } from "./poolBlacklist";
import { followsDeployment, inMandatoryWindow } from "./softForks";
import { getForkLanes } from "./forkLanes";

/**
 * The Forks summary per range, shared by /api/forks and the Forks pages (short links, link previews, the preview
 * image): computed once per SUMMARY_MS per process and range, and served stale while a refresh runs. POOL_BLACKLIST
 * is realtime-only: an excluded pool's work at or below our tip is history and is shown; above it (or with no tip), and
 * on another chain, it is left out (getEpisodes). Work on a soft fork's own chain (lib/softForks.ts: BIP-110's split) isn't a race
 * on Bitcoin's chain: it isn't shown, and is counted in the response.
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
  soft_fork_chains?: number;     // episodes on a soft fork's own chain (withoutSoftForkChains): not shown
  episodes?: Episode[];
}

// The summary entry being served per range: `settled` once its read finished, `fallback` = the previous result,
// served while this one is still running.
/**
 * A summary without template providers (`<range>-lite`: the Forks page, which doesn't show them), cached apart: all
 * history with them takes about a minute cold, without them a few seconds.
 */
export type SummaryKey = UnknownParentsRange | `${UnknownParentsRange}-lite`;

interface SummaryEntry { at: number; promise: Promise<SummaryResponse>; settled: SummaryResponse | null; fallback: SummaryResponse | null }
// On globalThis: Next.js bundles the API route, the pages and the image routes separately, each with its own copy of
// this module, and one cache per process is the point (a short link's first view would otherwise read every range
// again). Tests delete it to start cold.
const store = globalThis as { __forksSummaries?: Map<SummaryKey, SummaryEntry> };
const summaries = (store.__forksSummaries ??= new Map<SummaryKey, SummaryEntry>());

function refreshSummary(key: SummaryKey, now: number, fallback: SummaryResponse | null): SummaryEntry {
  const range = key.replace(/-lite$/, '') as UnknownParentsRange;
  const entry: SummaryEntry = {
    at: now, settled: null, fallback,
    // the tip first: it is the boundary of the excluded pools' history (lib/poolBlacklist.ts)
    promise: getBestTipHeight().then(async tip_height => {
      const ex = realtimeExclusion(tip_height);
      const { episodes: all, hidden: soft_fork_chains } = await withoutSoftForkChains(
        await getEpisodes(ex, range, { providers: !key.endsWith('-lite') }), ex);
      // Episodes that began before our first stored block have no Bitcoin position and no facts to judge them by
      // (collection started mid-height): not shown, and counted in the response.
      const episodes = await withNeverAppeared(all.filter(e => e.facts.tip_at_first !== null), all, ex);
      const before_first_block = all.length - episodes.length;
      const blocks = RANGE_BLOCKS[range];
      const from_height = tip_height === null ? null : blocks !== null ? tip_height - blocks
        : episodes.reduce((m, e) => (e.facts.tip_at_first === null ? m : Math.min(m, e.facts.tip_at_first)), tip_height);
      return { enabled: true, supported: true, range, blocks, tip_height, from_height, generated_at: Date.now(), before_first_block, soft_fork_chains, episodes };
    }),
  };
  entry.promise.then(r => { entry.settled = r; }, () => {
    // Don't keep a failure: serve the previous result (if any) as stale, so the next request retries.
    if (summaries.get(key) !== entry) return;
    if (fallback) summaries.set(key, { at: 0, promise: Promise.resolve(fallback), settled: fallback, fallback: null });
    else summaries.delete(key);
  });
  summaries.set(key, entry);
  return entry;
}

/**
 * The episodes without those on a soft fork's own chain (followsDeployment: a parent inside its mandatory window,
 * our best block there not signalling, every template on the parent signalling), and how many were left out. Only
 * episodes inside a window are read again (a few heights).
 */
export async function withoutSoftForkChains(episodes: Episode[], ex: RealtimeExclusion): Promise<{ episodes: Episode[]; hidden: number }> {
  const candidates = episodes.filter(e => inMandatoryWindow(e.height));
  if (candidates.length === 0) return { episodes, hidden: 0 };
  const rows = await getParentVersions(candidates.map(e => ({ parent: e.parent, height: e.height, first_ms: e.first_ms, last_ms: e.last_ms })),
    excludedAt(ex, Math.max(...candidates.map(e => e.height))));
  const hide = new Set<Episode>();
  for (const r of rows) {
    const e = candidates[r.i - 1];
    const bestVersion = r.best_version === null ? null : Number(r.best_version);
    if (followsDeployment(e.height, r.best_hash === e.parent, bestVersion, r.versions.map(Number))) hide.add(e);
  }
  return { episodes: episodes.filter(e => !hide.has(e)), hidden: hide.size };
}

const NEVER_MS = 10 * 60_000;
const neverStore = globalThis as { __forksNeverAppeared?: Map<string, { at: number; promise: Promise<boolean> }> };
const neverCache = (neverStore.__forksNeverAppeared ??= new Map());

/**
 * Unrecorded blocks ('bitcoin_block') that their height's lanes show never appeared (lib/forkStatus.ts neverAppeared)
 * get the kind 'never_appeared'. Only those episodes are read (a handful in all history): each one's height through
 * getForkLanes, over the span of every episode at that height (as /api/forks/timeline reads it), cached per parent for
 * NEVER_MS. A read that fails leaves the kind as it was (logged).
 */
export async function withNeverAppeared(episodes: Episode[], all: Episode[], ex: RealtimeExclusion): Promise<Episode[]> {
  const now = Date.now();
  const judged = await Promise.all(episodes.map(e => {
    if (e.kind !== 'bitcoin_block') return Promise.resolve(false);
    let entry = neverCache.get(e.parent);
    if (!entry || now - entry.at > NEVER_MS) {
      const at = all.filter(o => o.kind !== 'other_chain' && (o.heights?.length ? o.heights : [o.height]).includes(e.height));
      const span = { fromMs: Math.min(...at.map(o => o.first_ms)), toMs: Math.max(...at.map(o => o.last_ms)) };
      const promise = getForkLanes(e.height, span, ex)
        .then(l => l.parents.some(p => p.hash === e.parent && p.kind === 'never_appeared'))
        .catch(error => { console.error(`Forks: reading ${e.parent}'s lanes failed:`, error); neverCache.delete(e.parent); return false; });
      entry = { at: now, promise };
      neverCache.set(e.parent, entry);
    }
    return entry.promise;
  }));
  return episodes.map((e, i) => (judged[i] ? { ...e, kind: 'never_appeared' as const } : e));
}

/** The range's summary (callers check enableHistoricalData first: this reads the database). */
export async function getSummary(range: SummaryKey): Promise<SummaryResponse> {
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

const BLOCKS_MS = 5 * 60_000;
const BLOCKS_ENTRIES = 200;
const blockStore = globalThis as { __forksCardBlocks?: Map<number, { at: number; promise: Promise<DrillBlockRow[]> }> };
const blockCache = (blockStore.__forksCardBlocks ??= new Map());

/**
 * The blocks we know at height - 1 and height (getDrillBlocks: the drill-in's, with its miner rule), for the
 * link-preview card; cached per height for BLOCKS_MS (at most BLOCKS_ENTRIES heights). null: nothing to read.
 */
export async function loadBlocksAt(height: number): Promise<DrillBlockRow[] | null> {
  if (!enableHistoricalData) return null;
  const now = Date.now();
  let entry = blockCache.get(height);
  if (!entry || now - entry.at > BLOCKS_MS) {
    const promise = getDrillBlocks(height);
    entry = { at: now, promise };
    blockCache.delete(height);
    blockCache.set(height, entry);
    while (blockCache.size > BLOCKS_ENTRIES) blockCache.delete(blockCache.keys().next().value as number);
    promise.catch(() => { if (blockCache.get(height)?.promise === promise) blockCache.delete(height); });
  }
  try {
    return await entry.promise;
  } catch (error) {
    console.error("Error reading blocks for a forks card:", error);
    return null;
  }
}
