import { NextResponse } from "next/server";
// Relative imports so the route can be unit-tested (lib/__tests__/pgTemplateProviders.test.ts)
import { enableHistoricalData } from "../../../lib/db/blocks";
import { getTemplateProviderInputs } from "../../../lib/db/template-providers";
import { deriveTemplateProviders, type TemplateProviders } from "../../../lib/templateProviders";
import { blacklistedPoolNames } from "../../../lib/poolBlacklist";

export const dynamic = "force-dynamic";

/**
 * Who builds the templates: blocks by template provider (lib/templateProviders.ts; docs/methodology.md, "Template
 * providers"), derived at read time from the backend's per-height transaction-set counts.
 *
 *   GET /api/template-providers[?range=6e|26e|all]
 *       { columns (one per counted difficulty epoch, oldest first, then "now" = the last 144 blocks), pies (the last
 *       144 / 2,016 / 12,096 / 52,416 blocks and All), legend, tip_height, from_height, heights_counted, range,
 *       generated_at (ms) }. range narrows the columns to the last 6 or 26 epochs (default all); pies, colours and
 *       legend don't change with it.
 *       404 while nothing is counted yet, or with historical data disabled (the home page leaves the section out).
 *
 * POOL_BLACKLIST feeds are dropped before grouping: they add no node, pair or feed name, and a pool only they pay is
 * "not on our feeds". POOL_OWN_TEMPLATE_CREATORS (comma-separated prefixes, default none) names the DATUM template
 * creators that are a pool's own template servers: their blocks count as the pool's, not as miner-built. Computed once
 * per SUMMARY_MS per process and served stale while a refresh runs.
 */
const SUMMARY_MS = 5 * 60_000;
const RANGES: Record<string, number | null> = { "6e": 6, "26e": 26, all: null };

function ownCreatorPrefixes(): string[] {
  return (process.env.POOL_OWN_TEMPLATE_CREATORS ?? "").split(",").map(s => s.trim()).filter(Boolean);
}

interface Entry { at: number; promise: Promise<TemplateProviders | null>; settled: TemplateProviders | null | undefined; fallback: TemplateProviders | null }
let current: Entry | null = null;

function refresh(now: number, fallback: TemplateProviders | null): Entry {
  const entry: Entry = {
    at: now, settled: undefined, fallback,
    promise: getTemplateProviderInputs(blacklistedPoolNames())
      .then(inputs => deriveTemplateProviders({ ...inputs, ownCreatorPrefixes: ownCreatorPrefixes() })),
  };
  entry.promise.then(r => { entry.settled = r; }, () => {
    // Don't keep a failure: serve the previous result (if any) as stale, so the next request retries.
    if (current !== entry) return;
    current = fallback ? { at: 0, promise: Promise.resolve(fallback), settled: fallback, fallback: null } : null;
  });
  current = entry;
  return entry;
}

async function getSummary(): Promise<TemplateProviders | null> {
  const now = Date.now();
  const entry = !current || now - current.at > SUMMARY_MS
    ? refresh(now, current?.settled ?? current?.fallback ?? null) : current;
  if (entry.settled !== undefined) return entry.settled;
  return entry.fallback ?? entry.promise;
}

export async function GET(request: Request) {
  if (!enableHistoricalData) return NextResponse.json({ error: "historical data is disabled" }, { status: 404 });
  const range = new URL(request.url).searchParams.get("range") ?? "all";
  if (!Object.hasOwn(RANGES, range)) {
    return NextResponse.json({ error: `range must be one of ${Object.keys(RANGES).join(", ")}` }, { status: 400 });
  }
  try {
    const summary = await getSummary();
    if (!summary) return NextResponse.json({ error: "no transaction sets counted yet" }, { status: 404 });
    const epochs = RANGES[range];
    // the epoch columns, then "now" (always last)
    const columns = epochs === null ? summary.columns
      : [...summary.columns.slice(0, -1).slice(-epochs), ...summary.columns.slice(-1)];
    return NextResponse.json({ ...summary, columns, range, generated_at: Date.now() },
      { headers: { "Cache-Control": "public, max-age=60" } });
  } catch (error: unknown) {
    console.error("Error reading template providers:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
