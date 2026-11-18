import { NextResponse } from "next/server";
// Relative imports so the route can be unit-tested (lib/__tests__/otherChainsRoute.test.ts)
import { enableHistoricalData } from "../../../lib/db/blocks";
import { isPostgres } from "../../../lib/db/backend";
import {
  getOtherChainsSummary, getOtherTemplates, OTHER_CHAINS_CHAINS, OTHER_CHAINS_PAGE_MAX, type OtherChainsSummary,
} from "../../../lib/db/other-chains";
import { toOtherChainTemplate, type OtherChainTemplate } from "../../../lib/otherChains";
import { blacklistedPoolNames } from "../../../lib/poolBlacklist";

export const dynamic = "force-dynamic";

/**
 * Templates of the last 90 days that don't build on our Bitcoin chain, judged at read time (lib/db/other-chains.ts):
 * chain 'unknown' / reason 'no_bitcoin_parent' (the previous block is no block we know: other chains on the same
 * connections, mostly) and chain 'btc' / reason 'stale_bitcoin_parent' (built on a stale Bitcoin block). Read-only,
 * Postgres only (MongoDB mode answers supported: false without touching a database). POOL_BLACKLIST pools are left
 * out entirely.
 *
 *   GET /api/other-chains
 *       summary per (pool, chain, reason): counts, height range, distinct heights / prev hashes, first / last seen,
 *       AuxPoW share, templates per month (aligned with `months`), and `days` (the window)
 *   GET /api/other-chains?pool=NAME[&chain=unknown|btc][&reason=…][&n=50][&before=<µs cursor>]
 *       that group's templates, newest first, with decoded fields; `next_before` pages to older ones
 *
 * The summary reads every template of the window (about a second or two on a large table), so it's computed once per
 * SUMMARY_MS per process and served stale while a refresh runs. Template pages are cached for PAGE_MS.
 */
const SUMMARY_MS = 30 * 60_000;   // the read scans 90 days of templates (~15 s on production): at most once per 30 min per process
const PAGE_MS = 30_000;
const PAGE_CACHE_ENTRIES = 200;

interface SummaryResponse extends Partial<OtherChainsSummary> {
  enabled: boolean;
  supported: boolean;
  generated_at?: number;
}

interface TemplatesResponse {
  enabled: true;
  supported: true;
  pool: string;
  chain: string | null;
  reason: string | null;
  templates: OtherChainTemplate[];
  next_before: string | null;
}

// The summary entry being served: `settled` once its read finished, `fallback` = the previous result, served while
// this one is still running.
interface SummaryEntry { at: number; promise: Promise<SummaryResponse>; settled: SummaryResponse | null; fallback: SummaryResponse | null }
let summary: SummaryEntry | null = null;
const pages = new Map<string, { at: number; promise: Promise<TemplatesResponse> }>();

function refreshSummary(now: number, fallback: SummaryResponse | null): SummaryEntry {
  const entry: SummaryEntry = {
    at: now, settled: null, fallback,
    promise: getOtherChainsSummary(blacklistedPoolNames())
      .then(s => ({ enabled: true, supported: true, generated_at: Date.now(), ...s })),
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

const REASON_RE = /^[a-z0-9_]{1,64}$/;
const CURSOR_RE = /^\d{1,17}$/;

function bad(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (!enableHistoricalData) return NextResponse.json({ enabled: false, supported: false });
  if (!isPostgres()) return NextResponse.json({ enabled: true, supported: false });

  const pool = params.get("pool");
  try {
    if (pool === null) {
      return NextResponse.json(await getSummary(), { headers: { "Cache-Control": "public, max-age=60" } });
    }

    if (pool === "" || pool.length > 200) return bad("pool must be a pool name");
    const chain = params.get("chain");
    if (chain !== null && !(OTHER_CHAINS_CHAINS as readonly string[]).includes(chain)) {
      return bad(`chain must be one of ${OTHER_CHAINS_CHAINS.join(", ")}`);
    }
    const reason = params.get("reason");
    if (reason !== null && !REASON_RE.test(reason)) return bad("reason must be lower-case letters, digits or _");
    const before = params.get("before");
    if (before !== null && !CURSOR_RE.test(before)) return bad("before must be a µs timestamp (the next_before value)");
    const rawN = params.get("n");
    const parsed = rawN === null ? 50 : Number(rawN);
    if (!Number.isInteger(parsed) || parsed < 1) return bad("n must be a positive integer");
    const n = Math.min(parsed, OTHER_CHAINS_PAGE_MAX);

    const key = JSON.stringify([pool, chain, reason, before, n]);
    const now = Date.now();
    let entry = pages.get(key);
    if (!entry || now - entry.at > PAGE_MS) {
      const promise = getOtherTemplates({ pool, chain, reason, before, n }, blacklistedPoolNames())
        .then((page): TemplatesResponse => ({
          enabled: true, supported: true, pool, chain, reason,
          templates: page.rows.map(toOtherChainTemplate), next_before: page.next_before,
        }));
      entry = { at: now, promise };
      pages.delete(key);
      pages.set(key, entry);
      while (pages.size > PAGE_CACHE_ENTRIES) pages.delete(pages.keys().next().value as string);
      promise.catch(() => { if (pages.get(key)?.promise === promise) pages.delete(key); });
    }
    return NextResponse.json(await entry.promise, { headers: { "Cache-Control": "public, max-age=30" } });
  } catch (error: unknown) {
    console.error("Error reading other-chain templates:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
