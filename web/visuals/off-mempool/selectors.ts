import { OFF_STATE, type OffRow } from "@/lib/offMempool";

export const EPOCH = 2016;

export interface OffPoint {
  height: number;
  pool: string;
  txs: number;
  off: number;
  share: number;   // 0..1
  time_s: number;
}

export interface NoDataSpan {
  from: number;
  to: number;      // inclusive
  state: number;   // OFF_STATE, never measured
}

/** Measured blocks as points, the rest as spans of consecutive heights with the same no-data reason. */
export function offMempoolLayout(rows: OffRow[]): { points: OffPoint[]; noData: NoDataSpan[]; byHeight: Map<number, OffRow> } {
  const points: OffPoint[] = [];
  const noData: NoDataSpan[] = [];
  const byHeight = new Map<number, OffRow>();
  for (const r of rows) {
    const [height, pool, txs, off, state, time_s] = r;
    byHeight.set(height, r);
    if (state === OFF_STATE.measured && txs !== null && txs > 0 && off !== null) {
      points.push({ height, pool, txs, off, share: off / txs, time_s });
      continue;
    }
    const last = noData[noData.length - 1];
    if (last && last.state === state && last.to === height - 1) last.to = height;
    else noData.push({ from: height, to: height, state });
  }
  return { points, noData, byHeight };
}

/** Epoch boundaries (heights) inside [from, to]. */
export function epochTicks(from: number, to: number): number[] {
  const out: number[] = [];
  for (let h = Math.ceil(from / EPOCH) * EPOCH; h <= to; h += EPOCH) out.push(h);
  return out;
}

/** The point nearest to (px, py) within `radius` px; points sorted by height. */
export function nearestPoint(points: OffPoint[], x: (h: number) => number, y: (s: number) => number,
  px: number, py: number, radius = 8): OffPoint | null {
  if (points.length === 0) return null;
  // binary search the first point whose x >= px - radius
  let lo = 0, hi = points.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (x(points[m].height) < px - radius) lo = m + 1; else hi = m; }
  let best: OffPoint | null = null, bestD = radius * radius;
  for (let i = lo; i < points.length && x(points[i].height) <= px + radius; i++) {
    const dx = x(points[i].height) - px, dy = y(points[i].share) - py, d = dx * dx + dy * dy;
    if (d <= bestD) { bestD = d; best = points[i]; }
  }
  return best;
}

export const NO_DATA_LABEL: Record<number, string> = {
  [OFF_STATE.missed]: "not recorded: the recorder or our node was down",
  [OFF_STATE.unchecked]: "not checked: the recorder wasn't synced",
  [OFF_STATE.afterGap]: "just after a gap in our record: transactions sent during it would look unseen",
  [OFF_STATE.coinbaseOnly]: "no transactions besides the coinbase",
};
