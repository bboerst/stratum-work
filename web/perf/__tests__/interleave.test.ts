import { describe, it, expect } from "vitest";
import { aggregate, median, schedule } from "../interleave";
import { markdown, type PageMetrics, type Results } from "../report";

const order = (steps: ReturnType<typeof schedule>, path: string) =>
  steps.filter((s) => s.path === path).map((s) => (s.side === "compare" ? "B" : "P")).join("");

describe("schedule", () => {
  it("measures only the primary side without a compare target, page by page", () => {
    const steps = schedule(["/", "/timing"], 3, false);
    expect(steps.map((s) => `${s.path}#${s.round}:${s.side}`)).toEqual([
      "/#0:primary", "/#1:primary", "/#2:primary", "/timing#0:primary", "/timing#1:primary", "/timing#2:primary",
    ]);
  });

  it("alternates sides within each page, swapping which goes first each round (ABBA)", () => {
    const steps = schedule(["/", "/timing"], 3, true);
    expect(order(steps, "/")).toBe("BPPBBP");
    expect(order(steps, "/timing")).toBe("BPPBBP");
    // pages stay contiguous: all of a page's runs, both sides, before the next page
    expect(steps.slice(0, 6).every((s) => s.path === "/")).toBe(true);
  });

  it("gives each side the requested number of runs", () => {
    for (const runs of [1, 2, 3, 5]) {
      const steps = schedule(["/"], runs, true);
      expect(steps.filter((s) => s.side === "primary")).toHaveLength(runs);
      expect(steps.filter((s) => s.side === "compare")).toHaveLength(runs);
    }
  });

  it("cancels a linear drift exactly with an even number of runs", () => {
    // run i of a page is slowed by i: with ABBA, both sides' positions sum to the same
    const pos = (side: string, runs: number) =>
      schedule(["/"], runs, true).flatMap((s, i) => (s.side === side ? [i] : [])).reduce((a, b) => a + b, 0);
    expect(pos("primary", 4)).toBe(pos("compare", 4));
    expect(Math.abs(pos("primary", 3) - pos("compare", 3))).toBe(1); // odd: one run's worth left over
  });
});

describe("aggregate", () => {
  const m = (v: number): PageMetrics => ({
    loadScriptS: v, loadLongestTaskMs: v * 10, loadLongTasksMs: v, streamCpuPct: v, streamLongTasks: v,
    streamLongestTaskMs: v, fps: 60 - v, heapMB: v, heapGrowthMB: v, domNodes: v,
  });

  it("takes each metric's median over the runs", () => {
    const a = aggregate([m(3), m(1), m(2)]);
    expect(a.loadScriptS).toBe(2);
    expect(a.loadLongestTaskMs).toBe(20);
    expect(a.fps).toBe(58);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("refuses an empty set of runs", () => {
    expect(() => aggregate([])).toThrow();
  });
});

describe("markdown header", () => {
  const pages: Record<string, PageMetrics> = {
    "/": { loadScriptS: 1, loadLongestTaskMs: 100, loadLongTasksMs: 100, streamCpuPct: 10, streamLongTasks: 0,
      streamLongestTaskMs: 0, fps: 60, heapMB: 6, heapGrowthMB: 0, domNodes: 500 },
  };
  const res = (interleaved: boolean, label?: string): Results => ({
    label, options: { runs: 3, cpu: 4, settleSeconds: 5, streamSeconds: 30, rate: 10, ...(interleaved ? { interleaved } : {}) }, pages,
  });

  it("says when the two sides were measured alternately", () => {
    expect(markdown(res(true, "this PR"), res(true, "main"))).toContain("compared with main, measured alternately in the same browser");
    expect(markdown(res(false, "this PR"), res(false, "main"))).not.toContain("alternately");
  });
});
