"use client";

import React, { useEffect, useState } from "react";
import { useOffPositions, type OffMempoolView } from "../framework/data";
import { formatRuns } from "@/lib/offMempool";
import type { OffPoint } from "./selectors";

// Shared by the two views of the off-mempool visual (OffMempool.tsx by height, ByProvider.tsx).

export const pct = (s: number) => (s === 0 ? "0%" : s < 0.001 ? "<0.1%" : `${(s * 100).toFixed(s < 0.1 ? 1 : 0)}%`);

/** Why there's nothing to draw yet, if so. */
export function viewMessage(view: OffMempoolView): string | null {
  if (view.loading && view.rows.length === 0 && !view.error) return "Loading blocks…";
  if (view.error) return view.error;
  if (view.recordFrom === null) return "The mempool recorder hasn't recorded a block yet.";
  return null;
}

/** The hovered block's off-mempool positions, fetched after a short pause on it (none for a block with no unseen). */
export function useDwellPositions(p: OffPoint | null) {
  const [dwell, setDwell] = useState<number | null>(null);
  useEffect(() => {
    if (!p || p.off === 0) return;
    const t = setTimeout(() => setDwell(p.height), 250);
    return () => clearTimeout(t);
  }, [p]);
  return useOffPositions(p && dwell === p.height ? dwell : null);
}

/** A block's tooltip lines. */
export function BlockTip({ p, runs }: { p: OffPoint; runs: [number, number][] | undefined }) {
  return (
    <>
      <div className="font-medium">{p.height.toLocaleString("en-US")} · {p.pool}</div>
      <div>{p.off.toLocaleString("en-US")} of {p.txs.toLocaleString("en-US")} never seen ({pct(p.share)})</div>
      {runs && runs.length > 0 && <div className="text-muted-foreground">positions {formatRuns(runs)}</div>}
      <div className="text-muted-foreground">{new Date(p.time_s * 1000).toLocaleString()}</div>
    </>
  );
}

