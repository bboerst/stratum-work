"use client";

import React, { useEffect, useMemo, useState } from "react";
import { formatPrevBlockHash } from "@/utils/formatters";

type AnalysisFlag = {
  key?: string;
  icon?: string;
  title?: string;
  tooltip?: string;
  details?: Record<string, unknown>;
};

interface AnalysisData {
  flags?: AnalysisFlag[];
}

interface BlockWithAnalysis {
  height: number;
  block_hash: string;
  analysis?: AnalysisData;
}

export default function AnalyticsPanel({ height }: { height: number }) {
  const [block, setBlock] = useState<BlockWithAnalysis | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        const res = await fetch(`/api/blocks?height=${height}&n=1`, { cache: "no-store" });
        const data = await res.json();
        const items: BlockWithAnalysis[] = Array.isArray(data.blocks) ? data.blocks : [];
        const found = items.find((b) => b.height === height) || null;
        if (!cancelled) setBlock(found);
      } catch {
        if (!cancelled) setBlock(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (height > 0) load();
    return () => {
      cancelled = true;
    };
  }, [height]);

  const flags = useMemo<AnalysisFlag[]>(() => {
    if (!block || !block.analysis || !Array.isArray(block.analysis.flags)) return [];
    return block.analysis.flags as AnalysisFlag[];
  }, [block]);

  if (loading) {
    return (
      <div className="border border-border rounded-md p-3 bg-card text-xs opacity-70">Loading analytics…</div>
    );
  }

  if (!flags || flags.length === 0) {
    return (
      <div className="border border-border rounded-md p-3 bg-card text-xs opacity-70">None</div>
    );
  }

  function renderPrevHashFork(flag: AnalysisFlag) {
    const groups = (flag.details && (flag.details as { groups?: Array<{ prev_hash?: string; pools?: string[] }> }).groups) || [];
    if (!groups || groups.length === 0) return null;
    return (
      <div className="mt-2">
        <div className="text-sm font-semibold mb-2">Previous Hash Divergence</div>
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${groups.length}, minmax(0, 1fr))` }}>
          {groups.map((g, idx) => (
            <div key={idx} className="border border-border rounded-md p-2 bg-background/60">
              <div className="text-[10px] opacity-75 mb-2 break-all">
                {g.prev_hash ? formatPrevBlockHash(g.prev_hash) : "(unknown prev_hash)"}
              </div>
              <div className="flex flex-wrap gap-1">
                {(g.pools || []).map((p) => (
                  <span key={p} className="px-2 py-0.5 text-[10px] rounded-full bg-muted text-foreground border border-border">
                    {p || "Unknown"}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function renderInvalidTemplates(flag: AnalysisFlag) {
    const offenders = (flag.details && (flag.details as { offenders?: Array<{ pool_name?: string; total_sats?: number; subsidy_sats?: number }> }).offenders) || [];
    if (!offenders || offenders.length === 0) return null;
    // Helpers
    const toBtc = (sats: number | undefined) => typeof sats === 'number' ? (sats / 100_000_000).toFixed(8) : 'n/a';
    // Aggregate by pool
    const byPool = new Map<string, { 
      pool: string; 
      count: number; 
      maxOverSats: number; 
      maxTotalSats: number; 
      subsidySats: number | undefined;
    }>();
    offenders.forEach((o) => {
      const name = o.pool_name || "Unknown";
      const over = (o.total_sats || 0) - (o.subsidy_sats || 0);
      const prev = byPool.get(name);
      if (prev) {
        prev.count += 1;
        prev.maxOverSats = Math.max(prev.maxOverSats, over);
        prev.maxTotalSats = Math.max(prev.maxTotalSats, o.total_sats || 0);
        prev.subsidySats = typeof o.subsidy_sats === 'number' ? o.subsidy_sats : prev.subsidySats;
      } else {
        byPool.set(name, { pool: name, count: 1, maxOverSats: over, maxTotalSats: o.total_sats || 0, subsidySats: o.subsidy_sats });
      }
    });
    const items = Array.from(byPool.values()).sort((a, b) => b.count - a.count || a.pool.localeCompare(b.pool));
    return (
      <div className="mt-4">
        <div className="text-sm font-semibold mb-2">Invalid Templates (no merkle)</div>
        <ul className="text-xs space-y-1">
          {items.map((it) => (
            <li key={it.pool} className="flex items-center justify-between border border-border rounded px-2 py-1 bg-background/60">
              <span className="truncate mr-2">{it.pool}</span>
              <span className="opacity-80 whitespace-nowrap">
                {it.count}× • max total {toBtc(it.maxTotalSats)} BTC
                {typeof it.subsidySats === 'number' ? ` (subsidy ${toBtc(it.subsidySats)} BTC, over +${toBtc(it.maxOverSats)} BTC)` : ''}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="border border-border rounded-md p-3 bg-card">
      {flags.map((f, i) => (
        <div key={`${f.key || i}`}>
          {f.key === "prev_hash_fork" && renderPrevHashFork(f)}
          {f.key === "invalid_coinbase_no_merkle" && renderInvalidTemplates(f)}
        </div>
      ))}
    </div>
  );
}


