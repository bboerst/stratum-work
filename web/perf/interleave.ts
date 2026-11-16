// Run order and aggregation for the perf harness (run.ts). Pure, so it can be unit-tested without a browser.
//
// When two builds are compared, one process measures both, alternating run by run within each page, so runner drift
// (a noisy neighbour, thermal or frequency changes, minutes apart) lands on both sides instead of all on one.

import type { PageMetrics } from "./report";

export type Side = "primary" | "compare";

export interface Step {
  path: string;
  round: number;
  side: Side;
}

/**
 * The measurement order. Per page, round by round; with a compare target each round measures both sides, and which
 * goes first alternates (compare, primary | primary, compare | compare, primary …: ABBA). Alternating cancels the
 * order effect (whatever the first run of a pair gets: a warmer cache, a quieter or busier moment) and, with an even
 * number of runs, a linear drift across the page exactly; with an odd number the leftover is one run's worth of drift,
 * which the median absorbs. Pages stay contiguous so a page's two sides are always measured minutes, not passes, apart.
 */
export function schedule(pages: string[], runs: number, compare: boolean): Step[] {
  const steps: Step[] = [];
  for (const path of pages) {
    for (let round = 0; round < runs; round++) {
      const pair: Side[] = !compare ? ["primary"] : round % 2 === 0 ? ["compare", "primary"] : ["primary", "compare"];
      for (const side of pair) steps.push({ path, round, side });
    }
  }
  return steps;
}

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** Per-metric median over a page's runs. */
export function aggregate(runs: PageMetrics[]): PageMetrics {
  if (!runs.length) throw new Error("no runs to aggregate");
  return Object.fromEntries(
    (Object.keys(runs[0]) as (keyof PageMetrics)[]).map((k) => [k, median(runs.map((r) => r[k]))])
  ) as unknown as PageMetrics;
}
