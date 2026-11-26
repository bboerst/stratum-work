"use client";

import { useEffect, useMemo, useState } from "react";
import { useTemplateBuffer } from "@/lib/DataStreamContext";
import { usePoolFilter } from "@/components/PoolFilterContext";
import type { BufferedTemplate } from "@/lib/templateBuffer";
import type { OffRow } from "@/lib/offMempool";

// The data layer visuals use (#157). It wraps the shared template buffer (live stream + history prefill, flood
// protection and the pool blacklist already applied server side) and the viewer's pool filter, so no visual talks
// to the stream or the APIs directly. More hooks (blocks, tip, history by height range) are added here, not in
// visuals.

export interface TemplatesView {
  /** Bitcoin templates the viewer has selected pools for, oldest first. */
  templates: BufferedTemplate[];
  currentHeight: number | null;
  tipHeight: number | null;
  /** True until the history prefill has finished (or was skipped): "no data yet" isn't "no data". */
  loading: boolean;
}

/**
 * Recent templates. `heights` keeps only the last N heights ending at the current one (the buffer holds 3).
 * The result only changes when the buffer does, so it's safe to derive memoized data from it.
 */
export function useTemplates({ heights }: { heights?: number } = {}): TemplatesView {
  const { entries, currentHeight, tipHeight, prefill } = useTemplateBuffer();
  const { isPoolVisible } = usePoolFilter();
  const templates = useMemo(() => {
    const minHeight = heights && currentHeight !== null ? currentHeight - heights + 1 : null;
    return entries.filter(
      (e) => (minHeight === null || e.data.height >= minHeight) && isPoolVisible(e.data.pool_name)
    );
  }, [entries, currentHeight, heights, isPoolVisible]);
  return {
    templates,
    currentHeight,
    tipHeight,
    loading: prefill.status === "pending" || prefill.status === "loading",
  };
}

export interface OffMempoolView {
  /** Per best-chain block from fromHeight (or recordFrom if higher), oldest first (lib/offMempool.ts). */
  rows: OffRow[];
  tipHeight: number | null;
  fromHeight: number | null;
  /** The first block the mempool recorder wrote: blocks below it have no data. */
  recordFrom: number | null;
  afterGapBlocks: number;
  /** Template providers as the home page groups them; rowProvider[i] is rows[i]'s index in it (null: not counted). */
  providers: { name: string; kind: "producer" | "miner" | "other"; pools: string[] }[];
  rowProvider: (number | null)[];
  loading: boolean;
  error: string | null;
}

const OFF_MEMPOOL_REFRESH_MS = 60_000;

/** Off-mempool share per block over a range of difficulty epochs (/api/off-mempool), refreshed every minute. */
export function useOffMempool(range: "6e" | "26e" | "all"): OffMempoolView {
  const [got, setGot] = useState<(Omit<OffMempoolView, "loading"> & { range: string }) | null>(null);
  useEffect(() => {
    let live = true;
    const empty = { rows: [], tipHeight: null, fromHeight: null, recordFrom: null, afterGapBlocks: 0, providers: [], rowProvider: [] };
    const load = () => fetch(`/api/off-mempool?range=${range}`)
      .then(r => r.json())
      .then(d => {
        if (!live) return;
        if (d.error || d.enabled === false) {
          setGot({ ...empty, range, error: d.error ?? "Historical data is disabled on this deployment." });
          return;
        }
        setGot({ range, rows: d.rows ?? [], tipHeight: d.tip_height, fromHeight: d.from_height, recordFrom: d.record_from,
          afterGapBlocks: d.after_gap_blocks, providers: d.providers ?? [], rowProvider: d.row_provider ?? [], error: null });
      })
      .catch(e => { if (live) setGot({ ...empty, range, error: String(e) }); });
    load();
    const t = setInterval(load, OFF_MEMPOOL_REFRESH_MS);
    return () => { live = false; clearInterval(t); };
  }, [range]);
  // until this range's first answer: loading, with no rows (never another range's)
  if (!got || got.range !== range) {
    return { rows: [], tipHeight: null, fromHeight: null, recordFrom: null, afterGapBlocks: 0, providers: [], rowProvider: [],
      loading: true, error: null };
  }
  const { range: _r, ...rest } = got;
  void _r;
  return { ...rest, loading: false };
}

/** The off-mempool positions of one block, as runs [first, last] (fetched when `height` is set). */
export function useOffPositions(height: number | null): { height: number; runs: [number, number][] } | null {
  const [got, setGot] = useState<{ height: number; runs: [number, number][] } | null>(null);
  useEffect(() => {
    if (height === null) return;
    let live = true;
    fetch(`/api/off-mempool?height=${height}`).then(r => r.json())
      .then(d => { if (live && Array.isArray(d.runs)) setGot({ height, runs: d.runs }); }).catch(() => {});
    return () => { live = false; };
  }, [height]);
  return got && got.height === height ? got : null;
}
