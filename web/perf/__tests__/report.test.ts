import { describe, it, expect } from "vitest";
import { COLUMNS, compareMetric, markdown, type PageMetrics, type Results } from "../report";

const col = (key: keyof PageMetrics) => COLUMNS.find((c) => c.key === key)!;

describe("compareMetric", () => {
  it("doesn't flag the spread seen between runs of identical code", () => {
    // from a PR that changed only the measuring tool: both sides ran the same app
    expect(compareMetric(col("streamLongTasks"), 84, 62)).toBe("same");
    expect(compareMetric(col("streamCpuPct"), 59.3, 57.3)).toBe("same");
  });

  it("flags real changes in either direction", () => {
    expect(compareMetric(col("loadLongestTaskMs"), 447, 3365)).toBe("better");
    expect(compareMetric(col("loadLongestTaskMs"), 3365, 447)).toBe("worse");
    expect(compareMetric(col("fps"), 39, 52)).toBe("worse"); // lower FPS is worse
    expect(compareMetric(col("streamLongTasks"), 17, 2)).toBe("worse"); // small base: the absolute floor applies
  });

  it("uses the absolute floor near zero", () => {
    expect(compareMetric(col("streamLongTasks"), 2, 0)).toBe("same");
    expect(compareMetric(col("streamLongTasks"), 3, 0)).toBe("worse");
  });
});

describe("markdown", () => {
  const m = (over: Partial<PageMetrics> = {}): PageMetrics => ({
    loadScriptS: 1, loadLongestTaskMs: 100, loadLongTasksMs: 100, streamCpuPct: 10, streamLongTasks: 0,
    streamLongestTaskMs: 0, fps: 60, heapMB: 6, heapGrowthMB: 0, domNodes: 500, ...over,
  });
  const res = (pages: Record<string, PageMetrics>, label?: string): Results => ({
    label, options: { runs: 3, cpu: 4, settleSeconds: 5, streamSeconds: 30, rate: 10 }, pages,
  });

  it("counts only metrics worse beyond noise", () => {
    const text = markdown(res({ "/": m({ loadLongestTaskMs: 900, streamCpuPct: 10.5 }) }), res({ "/": m() }, "main"));
    expect(text).toContain("(+800 ⚠️)");
    expect(text).not.toContain("+0.5");
    expect(text).toContain("⚠️ 1 metric(s) worse than main beyond noise.");
  });

  it("says so when nothing is worse", () => {
    expect(markdown(res({ "/": m() }), res({ "/": m() }, "main"))).toContain("No metric worse than main beyond noise.");
  });
});
