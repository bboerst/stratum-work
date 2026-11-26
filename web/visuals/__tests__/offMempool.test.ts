import { describe, expect, it } from "vitest";
import { OFF_STATE, type OffRow } from "@/lib/offMempool";
import { epochTicks, nearestPoint, offMempoolLayout } from "../off-mempool/selectors";

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
});
