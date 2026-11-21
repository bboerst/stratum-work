"use client";

import React, { useEffect, useState } from "react";
import ForkTimeline from "./ForkTimeline";
import { reverseHex } from "@/utils/formatters";
import type { PrevHashStatus } from "@/lib/forkStatus";
import type { ParentKind } from "@/lib/parentKind";
import type { ArrivalBlock } from "@/lib/forkTimelineAxis";

interface Notification {
  pool_name?: string | null;
  timestamp: string;
  prev_hash: string;
}

interface AnalysisDataResult {
  height: number;
  mining_notifications?: Notification[];
  previous_block?: { hash?: string } | null;
  prev_hash_status?: Record<string, PrevHashStatus> | null;
  prev_hash_kind?: Record<string, ParentKind> | null;
  blocks?: ArrivalBlock[] | null;
}

interface HeightFork {
  notifications: Notification[];   // prev_hash in the timeline's (template) order
  canonicalHash?: string;
  status: Record<string, PrevHashStatus> | null;
  kind: Record<string, ParentKind> | null;
  blocks: ArrivalBlock[];
}

/**
 * The fork timeline of one height: every feed's templates at it (/api/analysis-data, with its POOL_BLACKLIST rule),
 * what each parent is, and the blocks at height - 1 and height with when they reached us. Only the fields the chart
 * reads are kept (a busy height's response is megabytes).
 */
export function useHeightFork(height: number): { data: HeightFork | null; loading: boolean; error: boolean } {
  const [state, setState] = useState<{ height: number; data: HeightFork | null; error: boolean } | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    fetch(`/api/analysis-data?height=${height}`, { cache: "no-store", signal: ctl.signal })
      .then((r) => r.json())
      .then((d: { results?: AnalysisDataResult[] }) => {
        const r = (Array.isArray(d.results) ? d.results : []).find((x) => x.height === height);
        setState({
          height, error: false,
          data: r ? {
            notifications: (r.mining_notifications ?? []).map((n) => ({
              pool_name: n.pool_name, timestamp: n.timestamp, prev_hash: reverseHex(n.prev_hash),
            })),
            canonicalHash: r.previous_block?.hash,
            status: r.prev_hash_status ?? null,
            kind: r.prev_hash_kind ?? null,
            blocks: r.blocks ?? [],
          } : null,
        });
      })
      .catch((e) => { if (e?.name !== "AbortError") setState({ height, data: null, error: true }); });
    return () => ctl.abort();
  }, [height]);
  const current = state?.height === height ? state : null;
  return { data: current?.data ?? null, loading: current === null, error: current?.error ?? false };
}

/** The shared fork chart (the height page's Findings and the Forks page's episode drill-in), loaded for a height. */
export default function HeightForkTimeline({ height, title, invalidCoinbasePools }: {
  height: number;
  title?: string;
  invalidCoinbasePools?: string[] | null;
}) {
  const { data, loading, error } = useHeightFork(height);
  if (loading) return <div className="mt-2 text-xs text-muted-foreground">Loading fork…</div>;
  if (error) return <div className="mt-2 text-xs text-red-500">Couldn&apos;t load the templates at this height.</div>;
  if (!data || data.notifications.length === 0) return null;
  return (
    <ForkTimeline
      notifications={data.notifications}
      canonicalBlockHash={data.canonicalHash}
      prevHashStatus={data.status}
      prevHashKind={data.kind}
      blocks={data.blocks}
      invalidCoinbasePools={invalidCoinbasePools}
      title={title}
    />
  );
}
