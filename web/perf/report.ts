// Reporting for the perf harness (run.ts): the results table, and the base comparison with noise thresholds.

export interface PageMetrics {
  loadScriptS: number; // script time until settled
  loadLongestTaskMs: number;
  loadLongTasksMs: number; // total long-task time until settled
  streamCpuPct: number; // main-thread busy share while streaming
  streamLongTasks: number;
  streamLongestTaskMs: number;
  fps: number;
  heapMB: number; // after GC, end of the stream window
  heapGrowthMB: number; // over the stream window, after GC (leak signal)
  domNodes: number;
}


export type Results = {
  label?: string;
  options: {
    runs: number;
    cpu: number;
    settleSeconds: number;
    streamSeconds: number;
    rate: number;
    /** Measured in one process alternating run by run with the build it's compared with (run.ts --compare-url). */
    interleaved?: boolean;
  } & Record<string, unknown>;
  pages: Record<string, PageMetrics>;
};

/**
 * A change counts only beyond its noise: the larger of an absolute floor and a share of the base value. The shares
 * come from the spread between runs of identical code in CI (e.g. a page's streaming long-task count varied by ~35 %
 * between two runs of the same build), so a PR isn't flagged for noise. They were measured when CI ran the base and
 * the PR in two passes minutes apart, so runner drift landed on one side; CI now interleaves the two (interleave.ts),
 * which should narrow the spread. Re-derive the shares from interleaved runs before tightening them.
 */
export const COLUMNS: { key: keyof PageMetrics; title: string; digits: number; higherIsWorse: boolean; noise: number; rel: number }[] = [
  { key: "loadScriptS", title: "Load script (s)", digits: 2, higherIsWorse: true, noise: 0.1, rel: 0.15 },
  { key: "loadLongestTaskMs", title: "Load longest task (ms)", digits: 0, higherIsWorse: true, noise: 50, rel: 0.25 },
  { key: "streamCpuPct", title: "Streaming CPU (%)", digits: 1, higherIsWorse: true, noise: 2, rel: 0.15 },
  { key: "streamLongTasks", title: "Streaming long tasks", digits: 0, higherIsWorse: true, noise: 2, rel: 0.5 },
  { key: "streamLongestTaskMs", title: "Streaming longest task (ms)", digits: 0, higherIsWorse: true, noise: 50, rel: 0.3 },
  { key: "fps", title: "FPS", digits: 0, higherIsWorse: false, noise: 3, rel: 0.1 },
  { key: "heapMB", title: "Heap (MB)", digits: 1, higherIsWorse: true, noise: 1, rel: 0.1 },
  { key: "heapGrowthMB", title: "Heap growth (MB)", digits: 1, higherIsWorse: true, noise: 1, rel: 0.5 },
  { key: "domNodes", title: "DOM nodes", digits: 0, higherIsWorse: true, noise: 100, rel: 0.05 },
];

/** How a value compares with its base: "same" within noise, else "better" / "worse". */
export function compareMetric(c: (typeof COLUMNS)[number], value: number, base: number): "same" | "better" | "worse" {
  const d = value - base;
  if (Math.abs(d) <= Math.max(c.noise, c.rel * Math.abs(base))) return "same";
  return (c.higherIsWorse ? d > 0 : d < 0) ? "worse" : "better";
}

export function markdown(r: Results, base?: Results): string {
  const o = r.options;
  const lines = [
    `**Client performance** (median of ${o.runs} runs; Chromium, CPU ×${o.cpu}; ${o.settleSeconds} s settle, then ${o.streamSeconds} s of stream at ${o.rate} templates/s with a new block halfway${base ? `; compared with ${base.label ?? "base"}${o.interleaved ? ", measured alternately in the same browser" : ""}` : ""})`,
    "",
    `| Page | ${COLUMNS.map((c) => c.title).join(" | ")} |`,
    `|---|${COLUMNS.map(() => "---:").join("|")}|`,
  ];
  let worse = 0;
  for (const [path, m] of Object.entries(r.pages)) {
    const cells = COLUMNS.map((c) => {
      const v = m[c.key];
      let cell = v.toFixed(c.digits);
      const b = base?.pages[path]?.[c.key];
      if (b !== undefined) {
        const d = v - b;
        const verdict = compareMetric(c, v, b);
        if (verdict !== "same") {
          if (verdict === "worse") worse++;
          cell += ` (${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(c.digits)} ${verdict === "worse" ? "⚠️" : "✅"})`;
        }
      }
      return cell;
    });
    lines.push(`| \`${path}\` | ${cells.join(" | ")} |`);
  }
  if (base) lines.push("", worse ? `⚠️ ${worse} metric(s) worse than ${base.label ?? "base"} beyond noise.` : `No metric worse than ${base.label ?? "base"} beyond noise.`);
  lines.push("", "Long task: main thread blocked > 50 ms. Heap growth: after GC, over the streaming window (a leak signal). Lower is better except FPS. A change is flagged only beyond noise: the larger of a fixed floor and a share of the base value (perf/report.ts).");
  return lines.join("\n");
}

