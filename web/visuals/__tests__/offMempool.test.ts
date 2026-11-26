import { describe, expect, it } from "vitest";
import { OFF_STATE, type OffRow } from "@/lib/offMempool";
import { UNCOUNTED, epochTicks, jitter, nearestPoint, offMempoolLayout, providerRows } from "../off-mempool/selectors";

const row = (h: number, txs: number | null, off: number | null, state: number): OffRow => [h, "P", txs, off, state as OffRow[4], 0];

describe("off-mempool selectors", () => {
  it("only measured blocks are points; the rest are no-data spans by reason", () => {
    const rows = [
      row(10, 100, 5, OFF_STATE.measured), row(11, null, null, OFF_STATE.missed), row(12, null, null, OFF_STATE.missed),
      row(13, 100, 80, OFF_STATE.afterGap), row(14, 0, 0, OFF_STATE.coinbaseOnly), row(15, 200, 0, OFF_STATE.measured),
    ];
    const { points, noData } = offMempoolLayout(rows);
    expect(points.map(p => [p.height, p.share])).toEqual([[10, 0.05], [15, 0]]);
    expect(noData).toEqual([
      { from: 11, to: 12, state: OFF_STATE.missed }, { from: 13, to: 13, state: OFF_STATE.afterGap },
      { from: 14, to: 14, state: OFF_STATE.coinbaseOnly },
    ]);
  });
  it("epoch ticks", () => {
    expect(epochTicks(4000, 8100)).toEqual([4032, 6048, 8064]);
  });
  it("nearest point within the radius", () => {
    const { points } = offMempoolLayout([row(1, 10, 0, 0), row(2, 10, 5, 0), row(3, 10, 10, 0)]);
    const x = (h: number) => h * 10, y = (s: number) => 100 - s * 100;
    expect(nearestPoint(points, x, y, 21, 52)?.height).toBe(2);
    expect(nearestPoint(points, x, y, 21, 0)).toBeNull();   // (30, 0) is 9 px away
  });

  it("provider rows: measured blocks as points, the share pooled over them, most blocks first, others last", () => {
    const rows = [
      row(1, 100, 50, OFF_STATE.measured), row(2, 300, 0, OFF_STATE.measured), row(3, null, null, OFF_STATE.missed),
      row(4, 100, 10, OFF_STATE.measured), row(5, 100, null, OFF_STATE.afterGap), row(6, 10, 1, OFF_STATE.measured),
      row(7, 10, 0, OFF_STATE.measured),
    ];
    const providers = [
      { name: "A +1", kind: "producer" as const, pools: ["A", "B"] }, { name: "C", kind: "producer" as const, pools: ["C"] },
      { name: "not on our feeds", kind: "other" as const, pools: ["not on our feeds"] },
    ];
    const r = providerRows(rows, [0, 0, 0, 1, 0, 2, null], providers);
    expect(r.map(x => [x.name, x.blocks, x.points.length])).toEqual([["A +1", 4, 2], ["C", 1, 1], ["not on our feeds", 1, 1], [UNCOUNTED, 1, 1]]);
    expect(r[0].pooled).toBe(50 / 400);             // over its measured blocks only: never the after-gap count
    expect(r[1].pooled).toBe(0.1);
    const none = providerRows([row(9, null, null, OFF_STATE.missed)], [0], providers);
    expect(none[0].pooled).toBeNull();                // no data, not 0%
  });
  it("jitter is stable and within [-1, 1]", () => {
    expect(jitter(977_000)).toBe(jitter(977_000));
    for (let h = 0; h < 2000; h++) expect(Math.abs(jitter(h))).toBeLessThanOrEqual(1);
  });
});
