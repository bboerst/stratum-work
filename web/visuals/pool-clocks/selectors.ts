import { parseCoinbase } from "@/utils/coinbaseParser";
import type { BufferedTemplate } from "@/lib/templateBuffer";
import type { StratumV1Data } from "@/lib/types";

// Pool clocks (#157): some pools push a Unix time into the coinbase scriptSig when they build a job
// (coinbaseParser's "time" segment). Comparing it with the header's ntime, or with our own receive time, shows each
// pool backend's clock: a stable per-pool offset, and pools that share one may share infrastructure.

export type ClockReference = "ntime" | "received";

export interface ClockSample {
  receivedMs: number;
  /** Pool time minus the reference, seconds (pool clock ahead = positive). */
  offset: number;
}

export interface PoolClock {
  pool: string;
  samples: ClockSample[];
  median: number;
  min: number;
  max: number;
  /** Share of this pool's templates that carried a time (some pools push it on some jobs only). */
  coverage: number;
}

export interface PoolClocksResult {
  pools: PoolClock[];
  /** Pools with templates in the window but no pushed time in any of them. */
  withoutClock: string[];
}

// Parsing is per template object and templates are immutable once buffered, so cache by object identity.
const pushedTime = new WeakMap<StratumV1Data, number | null>();

export function templatePushedTime(t: StratumV1Data): number | null {
  const cached = pushedTime.get(t);
  if (cached !== undefined) return cached;
  const ntime = t.ntime && /^[0-9a-fA-F]{1,8}$/.test(t.ntime) ? parseInt(t.ntime, 16) : undefined;
  let time: number | null = null;
  if (ntime !== undefined) {
    const parsed = parseCoinbase(t.coinbase1, t.extranonce1 || "", Number(t.extranonce2_length), t.coinbase2, { ntime });
    time = parsed.scriptSig?.time ?? null;
  }
  pushedTime.set(t, time);
  return time;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

export function poolClocks(
  templates: BufferedTemplate[],
  reference: ClockReference,
  sortBy: "offset" | "name" = "offset"
): PoolClocksResult {
  const byPool = new Map<string, { samples: ClockSample[]; total: number }>();
  for (const e of templates) {
    const pool = e.data.pool_name;
    let entry = byPool.get(pool);
    if (!entry) byPool.set(pool, (entry = { samples: [], total: 0 }));
    entry.total++;
    const time = templatePushedTime(e.data);
    if (time === null) continue;
    let ref: number;
    if (reference === "ntime") {
      ref = parseInt(e.data.ntime as string, 16); // present: templatePushedTime needs it
    } else {
      if (!Number.isFinite(e.timeMs)) continue;
      ref = e.timeMs / 1000;
    }
    entry.samples.push({ receivedMs: e.timeMs, offset: time - ref });
  }

  const pools: PoolClock[] = [];
  const withoutClock: string[] = [];
  for (const [pool, { samples, total }] of byPool) {
    if (samples.length === 0) {
      withoutClock.push(pool);
      continue;
    }
    const offsets = samples.map((s) => s.offset).sort((a, b) => a - b);
    pools.push({
      pool,
      samples,
      median: median(offsets),
      min: offsets[0],
      max: offsets[offsets.length - 1],
      coverage: samples.length / total,
    });
  }
  pools.sort((a, b) => (sortBy === "name" ? a.pool.localeCompare(b.pool) : a.median - b.median || a.pool.localeCompare(b.pool)));
  withoutClock.sort((a, b) => a.localeCompare(b));
  return { pools, withoutClock };
}

/** Pools whose medians are within `toleranceS` of each other, in runs along the sorted offsets: shared-clock hints. */
export function clockGroups(pools: PoolClock[], toleranceS: number): string[][] {
  const sorted = [...pools].sort((a, b) => a.median - b.median);
  const groups: string[][] = [];
  let current: PoolClock[] = [];
  for (const p of sorted) {
    if (current.length && p.median - current[current.length - 1].median > toleranceS) {
      if (current.length > 1) groups.push(current.map((c) => c.pool));
      current = [];
    }
    current.push(p);
  }
  if (current.length > 1) groups.push(current.map((c) => c.pool));
  return groups;
}
