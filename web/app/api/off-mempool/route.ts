import { NextResponse } from "next/server";
// Relative imports so the route can be unit-tested (lib/__tests__/offMempoolRoute.test.ts)
import { enableHistoricalData } from "../../../lib/db/blocks";
import { DEFAULT_RANGE, RANGE_BLOCKS, UNKNOWN_PARENTS_RANGES, type UnknownParentsRange } from "../../../lib/db/unknown-parents";
import { getBestTipHeight } from "../../../lib/db/unknown-parents";
import { getChainBlocks, getOffPositions, getRecordedBlocks, getRecordFrom, getResyncTimes } from "../../../lib/db/off-mempool";
import { AFTER_GAP_BLOCKS, assembleOffMempool, leadIn, positionRuns, type OffRow } from "../../../lib/offMempool";
import { getTemplateProviderInputs } from "../../../lib/db/template-providers";
import { blockProviders, type GroupKind } from "../../../lib/templateProviders";

export const dynamic = "force-dynamic";

/**
 * Off-mempool share per block (#328): of each best-chain block's transactions, how many our node never had in its
 * mempool before the block connected (the mempool recorder's mempool_blocks / mempool_offmempool). Read-only, over a
 * range in Bitcoin time like /api/forks: the last 6 (default) or 26 difficulty epochs below our tip, or all history,
 * and never below the first block the recorder wrote (record_from): earlier blocks have no data, not zero.
 *
 *   GET /api/off-mempool[?range=6e|26e|all]
 *       { enabled, supported, range, tip_height, from_height, record_from, after_gap_blocks, generated_at (ms),
 *         rows: [height, miner, transactions excl. the coinbase | null, off-mempool (null unless measured) | null, state, header time (s)][] }
 *       state (lib/offMempool.ts OFF_STATE): 0 measured; no data: 1 missed (no recorder row), 2 unchecked (written
 *       while not synced), 3 after a recorder gap, 4 coinbase only
 *       providers: { name, kind (producer | miner | other), pools (by blocks, most first) }[]: the template providers
 *       as the home page's "All" pie groups them (lib/templateProviders.ts blockProviders, the same rule), and
 *       row_provider: per row, its index in providers (null: the block's epoch isn't counted, or the counts aren't there)
 *   GET /api/off-mempool?height=<n>
 *       { height, runs: [first, last][] }: the positions (1 = first after the coinbase) of the off-mempool
 *       transactions of the best-chain block at that height, as runs of consecutive positions
 *
 * Blocks are shown with their miner, excluded pools too: a block's miner is history (lib/poolBlacklist.ts).
 * Computed once per SUMMARY_MS per process and range (a failure isn't kept); the resync times once per SYNCS_MS, the
 * template providers once per PROVIDERS_MS.
 */
const SUMMARY_MS = 60_000;
const SYNCS_MS = 10 * 60_000;
const PROVIDERS_MS = 5 * 60_000;   // like /api/template-providers

function ownCreatorPrefixes(): string[] {
  return (process.env.POOL_OWN_TEMPLATE_CREATORS ?? "").split(",").map(s => s.trim()).filter(Boolean);
}

/** Each row's template provider (all history counted, excluded pools too: a block's provider is history). */
async function providersOf(rows: OffRow[]): Promise<Pick<OffMempoolResponse, "providers" | "row_provider">> {
  let bp: ReturnType<typeof blockProviders> = null;
  try {
    bp = await cached(cache.providers, "all", PROVIDERS_MS, async () =>
      blockProviders({ ...(await getTemplateProviderInputs([])), ownCreatorPrefixes: ownCreatorPrefixes() }));
  } catch (error: unknown) {
    // the template_set tables aren't there yet (migration pending): no providers, the rows still stand
    if ((error as { code?: string })?.code !== "42P01") throw error;
  }
  const providers: OffMempoolResponse["providers"] = [];
  const index = new Map<string, number>();
  const row_provider = rows.map(r => {
    const key = bp?.keyOf.get(r[0]);
    const group = key === undefined ? undefined : bp!.groups.get(key);
    if (key === undefined || !group) return null;
    if (!index.has(key)) {
      index.set(key, providers.length);
      providers.push({ name: group.name, kind: group.kind, pools: group.kind === "miner" ? group.via.map(([p]) => p) : group.pools });
    }
    return index.get(key)!;
  });
  return { providers, row_provider };
}

export interface OffMempoolResponse {
  enabled: true;
  supported: true;
  range: UnknownParentsRange;
  tip_height: number | null;
  from_height: number | null;
  record_from: number | null;
  after_gap_blocks: number;
  generated_at: number;
  rows: OffRow[];
  providers: { name: string; kind: GroupKind; pools: string[] }[];
  row_provider: (number | null)[];
}

type Cached<T> = { at: number; promise: Promise<T> };
const g = globalThis as unknown as { __offMempool?: { summaries: Map<string, Cached<OffMempoolResponse>>;
  syncs: Map<string, Cached<number[]>>; providers: Map<string, Cached<ReturnType<typeof blockProviders>>> } };
const cache = (g.__offMempool ??= { summaries: new Map(), syncs: new Map(), providers: new Map() });

function cached<K, T>(map: Map<K, Cached<T>>, key: K, ttl: number, read: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = map.get(key);
  if (hit && now - hit.at <= ttl) return hit.promise;
  const promise = read();
  map.set(key, { at: now, promise });
  promise.catch(() => { if (map.get(key)?.promise === promise) map.delete(key); });
  return promise;
}

async function summary(range: UnknownParentsRange): Promise<OffMempoolResponse> {
  const [tip, recordFrom] = await Promise.all([getBestTipHeight(), getRecordFrom()]);
  const base = { enabled: true as const, supported: true as const, range, tip_height: tip, record_from: recordFrom,
    after_gap_blocks: AFTER_GAP_BLOCKS, generated_at: Date.now() };
  const none = { rows: [], providers: [], row_provider: [] };
  if (tip === null || recordFrom === null) return { ...base, from_height: tip, ...none };
  const blocks = RANGE_BLOCKS[range];
  const from = Math.max(blocks === null ? recordFrom : tip - blocks, recordFrom);
  if (from > tip) return { ...base, from_height: tip - (blocks ?? 0), ...none };
  const lo = leadIn(from, recordFrom);
  const [chain, recorded] = await Promise.all([getChainBlocks(lo, tip), getRecordedBlocks(lo, tip)]);
  let firstSeen = Infinity;
  for (const r of recorded.values()) firstSeen = Math.min(firstSeen, r.seen_ms);
  // syncs since the range's first recorded block, read once per SYNCS_MS per range (~1 s); a sync newer than the
  // cached read shows within SYNCS_MS
  const syncs = Number.isFinite(firstSeen) ? await cached(cache.syncs, range, SYNCS_MS, () => getResyncTimes(firstSeen)) : [];
  const rows = assembleOffMempool(chain, recorded, syncs, recordFrom, from);
  return { ...base, from_height: blocks === null ? recordFrom : tip - blocks, rows, ...(await providersOf(rows)) };
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (!enableHistoricalData) return NextResponse.json({ enabled: false, supported: false });
  try {
    const height = params.get("height");
    if (height !== null) {
      const h = Number(height);
      if (!/^\d{1,10}$/.test(height) || h > 2_147_483_647) return NextResponse.json({ error: "height must be a block height" }, { status: 400 });
      return NextResponse.json({ height: h, runs: positionRuns(await getOffPositions(h)) },
        { headers: { "Cache-Control": "public, max-age=60" } });
    }
    const range = (params.get("range") ?? DEFAULT_RANGE) as UnknownParentsRange;
    if (!UNKNOWN_PARENTS_RANGES.includes(range)) {
      return NextResponse.json({ error: `range must be one of ${UNKNOWN_PARENTS_RANGES.join(", ")}` }, { status: 400 });
    }
    const body = await cached(cache.summaries, range, SUMMARY_MS, () => summary(range));
    return NextResponse.json(body, { headers: { "Cache-Control": "public, max-age=60" } });
  } catch (error: unknown) {
    console.error("Error reading off-mempool blocks:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
