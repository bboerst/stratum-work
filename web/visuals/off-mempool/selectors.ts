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

export interface ProviderRow {
  name: string;
  kind: "producer" | "miner" | "other" | "uncounted";
  pools: string[];
  points: OffPoint[];       // measured blocks
  blocks: number;           // all its blocks in the range, measured or not
  /** unseen transactions over all transactions of its measured blocks (null: none measured) */
  pooled: number | null;
}

export const UNCOUNTED = "provider not counted";

/**
 * One row per template provider (the home page's grouping, from the API): its measured blocks as points and its share
 * over all of them. Most blocks first; "other" groups (not on our feeds, unidentified) and blocks whose provider isn't
 * counted last.
 */
export function providerRows(rows: OffRow[], rowProvider: (number | null)[],
  providers: { name: string; kind: "producer" | "miner" | "other"; pools: string[] }[]): ProviderRow[] {
  const out = new Map<number, ProviderRow>();
  const sums = new Map<number, { off: number; txs: number }>();
  rows.forEach((r, i) => {
    const pi = rowProvider[i] ?? -1;
    if (!out.has(pi)) {
      const p = providers[pi];
      out.set(pi, p ? { name: p.name, kind: p.kind, pools: p.pools, points: [], blocks: 0, pooled: null }
        : { name: UNCOUNTED, kind: "uncounted", pools: [], points: [], blocks: 0, pooled: null });
      sums.set(pi, { off: 0, txs: 0 });
    }
    const row = out.get(pi)!;
    row.blocks++;
    const [height, pool, txs, off, state, time_s] = r;
    if (state === OFF_STATE.measured && txs !== null && txs > 0 && off !== null) {
      row.points.push({ height, pool, txs, off, share: off / txs, time_s });
      const s = sums.get(pi)!;
      s.off += off; s.txs += txs;
    }
  });
  for (const [pi, row] of out) {
    const s = sums.get(pi)!;
    row.pooled = s.txs > 0 ? s.off / s.txs : null;
  }
  const last = (k: ProviderRow["kind"]) => (k === "other" ? 1 : k === "uncounted" ? 2 : 0);
  return [...out.values()].sort((a, b) => last(a.kind) - last(b.kind) || b.blocks - a.blocks || a.name.localeCompare(b.name));
}

/** A stable vertical offset in [-1, 1] for a block's dot within its row (so dots at the same share don't stack). */
export function jitter(height: number): number {
  return (((height * 2654435761) >>> 0) % 1000) / 500 - 1;
}
