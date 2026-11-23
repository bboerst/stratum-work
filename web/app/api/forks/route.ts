import { NextResponse } from "next/server";
// Relative imports so the route can be unit-tested (lib/__tests__/forksRoute.test.ts)
import { enableHistoricalData } from "../../../lib/db/blocks";
import {
  DEFAULT_RANGE, LEGACY_RANGES, UNKNOWN_PARENTS_RANGES, type UnknownParentsRange,
} from "../../../lib/db/unknown-parents";
import { getDrill, providerEpoch, readEpochGroups, type Drill, type Episode } from "../../../lib/unknownParents";
import { blacklistedPoolNames } from "../../../lib/poolBlacklist";
import { getSummary, type SummaryResponse } from "../../../lib/forksSummary";
import { raceRows } from "../../../lib/forkRaces";

/**
 * GET /api/forks?view=strip: the page's history strip, all history in a few KB: per row (lib/forkRaces.ts: a race
 * per fork point, every other episode alone; other chains apart) [position, height, kind, invalid (0/1), key], and
 * the epochs with another chain's work.
 */
function stripView(s: SummaryResponse) {
  const rows = raceRows((s.episodes ?? []).filter(e => e.kind !== "other_chain"));
  const other = [...new Set((s.episodes ?? []).filter(e => e.kind === "other_chain" && e.facts.tip_at_first !== null)
    .map(e => Math.floor((e.facts.tip_at_first! + 1) / 2016)))].sort((a, b) => a - b);
  return {
    enabled: s.enabled, supported: s.supported, tip_height: s.tip_height ?? null, from_height: s.from_height ?? null,
    generated_at: s.generated_at, other_chain_epochs: other,
    rows: rows.map(r => [r.position, r.heights[0], r.kind, r.invalid ? 1 : 0, r.key] as const),
  };
}

/**
 * GET /api/forks?view=providers: the template providers of each epoch with a Forks row, for grouping a row's pool tiles:
 * { epochs: { [epoch]: string[][] } }, each a provider's feeds (the rule is lib/templateProviders.ts, as on the
 * template providers page). An epoch whose providers aren't counted is absent.
 * Excluded pools are left out (readEpochRows). Read once per PROVIDERS_MS per process.
 */
const PROVIDERS_MS = 5 * 60_000;
const providersCache: { at: number; promise: Promise<{ epochs: Record<number, string[][]> }> } | { at: 0; promise: null } = { at: 0, promise: null };
async function providersView(): Promise<{ epochs: Record<number, string[][]> }> {
  const s = await getSummary("all-lite");
  const wanted = [...new Set((s.episodes ?? []).map(providerEpoch).filter((e): e is number => e !== null))];
  const groups = await readEpochGroups(wanted, blacklistedPoolNames());
  const epochs: Record<number, string[][]> = {};
  for (const [epoch, g] of groups) {
    const by = new Map<number, string[]>();
    for (const [feed, i] of g.feedOf) by.set(i, [...(by.get(i) ?? []), feed]);
    const all = [...by.values()]
      .map(fs => fs.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())))
      .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
    if (all.length > 0) epochs[epoch] = all;
  }
  return { epochs };
}

export const dynamic = "force-dynamic";

/**
 * Forks: templates built on a parent other than our best block, as episodes (one per parent), each with the facts its
 * kind rests on (lib/unknownParents.ts, lib/parentKind.ts): a recorded stale block ('stale'), or a parent that is no
 * block we know, whose kind is inferred ('bitcoin_block' = a stale block we never recorded, 'other_chain',
 * 'invalid_parent', 'undetermined'). Each episode carries the invalid-coinbase finding of our best block at its height
 * (invalid_coinbase); a finding with no episode at its height is a row of its own (kind 'invalid_coinbase'). Over a
 * range in Bitcoin time: the episodes whose last template arrived after the best-chain block 6 difficulty epochs
 * (12,096 blocks, default) or 26 epochs (52,416 blocks) below our tip did, or all history. Read-only. With historical
 * data disabled it answers enabled: false, supported: false without touching a database. POOL_BLACKLIST pools are
 * left out of this endpoint entirely: their templates, connections, findings and the episodes only they built on. (The
 * page's fork chart reads /api/analysis-data, which keeps them at mined heights, as the height page does.) The earlier range
 * values 90d and 1y are read as 6e and 26e (shared links); responses name the new ones. /api/unknown-parents is an
 * alias (the page's former name).
 *
 *   GET /api/forks[?range=6e|26e|all]
 *       { range, blocks (N; null for all), tip_height (our best-chain tip; null with no blocks), from_height,
 *       generated_at (ms), before_first_block, episodes: Episode[] } (oldest first); from_height is tip_height -
 *       blocks, or for all the lowest tip_at_first of the episodes (tip_height when there is none)
 *   GET /api/forks?range=…&providers=0
 *       the same without template providers (providers null, provider_groups empty): what the page reads
 *   GET /api/forks?view=strip
 *       all history as the page's strip (stripView, below)
 *   GET /api/forks?view=providers
 *       per epoch, the template providers and their feeds (providersView, below)
 *   GET /api/forks?parent=<64 hex, display order>[&range=...]
 *       one episode's drill-in: { episode, from_ms, to_ms, templates (decoded, each labelled by its parent),
 *       truncated, blocks (every block we know at height - 1 and height, with arrival) }; 404 if the parent isn't an
 *       episode of that range's summary
 *
 * The summary reads the backend's per-(parent, pool) tables of unknown and of stale parents (a few ms each) and the
 * findings; it's computed once per SUMMARY_MS per process and range and served stale while a refresh runs
 * (lib/forksSummary.ts, shared with the Forks pages). A drill-in is looked up in that summary (so it reads only the
 * episode's pools, heights and minutes) and cached for DRILL_MS.
 */
const DRILL_MS = 60_000;
const DRILL_CACHE_ENTRIES = 50;

interface DrillResponse extends Drill {
  enabled: true;
  supported: true;
  episode: Episode;
}

const drills = new Map<string, { at: number; promise: Promise<DrillResponse> }>();

const PARENT_RE = /^[0-9a-f]{64}$/;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (!enableHistoricalData) return NextResponse.json({ enabled: false, supported: false });

  const asked = params.get("range") ?? DEFAULT_RANGE;
  const range = (Object.hasOwn(LEGACY_RANGES, asked) ? LEGACY_RANGES[asked] : asked) as UnknownParentsRange;
  if (!UNKNOWN_PARENTS_RANGES.includes(range)) {
    return NextResponse.json({ error: `range must be one of ${UNKNOWN_PARENTS_RANGES.join(", ")}` }, { status: 400 });
  }
  const parent = params.get("parent");
  try {
    if (params.get("view") === "providers") {
      const now = Date.now();
      if (!providersCache.promise || now - providersCache.at > PROVIDERS_MS) {
        const promise = providersView();
        Object.assign(providersCache, { at: now, promise });
        promise.then(r => { if (Object.keys(r.epochs).length === 0) providersCache.at = 0; },   // a failed read (logged) isn't kept
          () => { if (providersCache.promise === promise) Object.assign(providersCache, { at: 0, promise: null }); });
      }
      return NextResponse.json(await providersCache.promise!, { headers: { "Cache-Control": "public, max-age=300" } });
    }
    if (params.get("view") === "strip") {
      return NextResponse.json(stripView(await getSummary("all-lite")), { headers: { "Cache-Control": "public, max-age=60" } });
    }
    // providers=0: without the template providers (the page doesn't show them; they cost most of a cold read)
    const key = params.get("providers") === "0" ? (`${range}-lite` as const) : range;
    if (parent === null) {
      return NextResponse.json(await getSummary(key), { headers: { "Cache-Control": "public, max-age=60" } });
    }
    const p = parent.toLowerCase();
    if (!PARENT_RE.test(p)) return NextResponse.json({ error: "parent must be 64 hex characters" }, { status: 400 });
    const episode = (await getSummary(key)).episodes?.find(e => e.parent === p);
    if (!episode) return NextResponse.json({ error: "no such episode in this range" }, { status: 404 });

    const now = Date.now();
    const cacheKey = `${key}:${p}`;
    let entry = drills.get(cacheKey);
    if (!entry || now - entry.at > DRILL_MS) {
      const promise = getDrill(episode, blacklistedPoolNames())
        .then((d): DrillResponse => ({ enabled: true, supported: true, episode, ...d }));
      entry = { at: now, promise };
      drills.delete(cacheKey);
      drills.set(cacheKey, entry);
      while (drills.size > DRILL_CACHE_ENTRIES) drills.delete(drills.keys().next().value as string);
      promise.catch(() => { if (drills.get(cacheKey)?.promise === promise) drills.delete(cacheKey); });
    }
    return NextResponse.json(await entry.promise, { headers: { "Cache-Control": "public, max-age=60" } });
  } catch (error: unknown) {
    console.error("Error reading forks:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
