"use client";

import React, { useEffect, useMemo, useState } from "react";
import ForkTimeline from "./ForkTimeline";
import { reverseHex } from "@/utils/formatters";

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

interface RawMiningNotify {
  pool_name?: string | null;
  chain_family?: string | null;
  timestamp: string;
  prev_hash: string;
}

interface AnalysisDataResult {
  height: number;
  mining_notifications?: RawMiningNotify[];
  previous_block?: {
    hash?: string;
  } | null;
}

interface AnalysisDataResponse {
  results?: AnalysisDataResult[];
}

export default function AnalyticsPanel({ height }: { height: number }) {
  const [block, setBlock] = useState<BlockWithAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [miningNotifications, setMiningNotifications] = useState<RawMiningNotify[]>([]);
  const [prevBlockHash, setPrevBlockHash] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        const [blockRes, analysisRes] = await Promise.all([
          fetch(`/api/blocks?height=${height}&n=1`, { cache: "no-store" }),
          fetch(`/api/analysis-data?height=${height}`, { cache: "no-store" }),
        ]);
        const blockData = await blockRes.json();
        const items: BlockWithAnalysis[] = Array.isArray(blockData.blocks) ? blockData.blocks : [];
        const found = items.find((b) => b.height === height) || null;

        let notifs: RawMiningNotify[] = [];
        let canonicalHash: string | undefined;
        try {
          const analysisData = await analysisRes.json();
          const analysisResponse = analysisData as AnalysisDataResponse;
          const analysisResults: AnalysisDataResult[] = Array.isArray(analysisResponse.results)
            ? analysisResponse.results
            : [];
          const analysisResult = analysisResults.find((result) => result.height === height) || null;
          notifs = analysisResult?.mining_notifications ?? [];
          canonicalHash = analysisResult?.previous_block?.hash;
        } catch { /* ignore */ }

        if (!cancelled) {
          setBlock(found);
          setMiningNotifications(notifs);
          setPrevBlockHash(canonicalHash);
        }
      } catch {
        if (!cancelled) {
          setBlock(null);
          setMiningNotifications([]);
          setPrevBlockHash(undefined);
        }
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

  const hasBchTemplate = useMemo(
    () => miningNotifications.some((notification) => notification.chain_family === "bch"),
    [miningNotifications]
  );

  const btcOnlyMiningNotifications = useMemo(
    () =>
      miningNotifications.filter(
        (notification) => notification.chain_family == null || notification.chain_family !== "bch"
      ),
    [miningNotifications]
  );

  const forkTimelineNotifications = useMemo(
    () =>
      btcOnlyMiningNotifications.map((notification) => ({
        ...notification,
        prev_hash: reverseHex(notification.prev_hash),
      })),
    [btcOnlyMiningNotifications]
  );

  if (loading) {
    return (
      <div className="border border-border rounded-md p-3 bg-card text-xs opacity-70">Loading analytics…</div>
    );
  }

  function renderPrevHashFork() {
    if (forkTimelineNotifications.length === 0) return null;
    return <ForkTimeline notifications={forkTimelineNotifications} canonicalBlockHash={prevBlockHash} />;
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
      {hasBchTemplate ? (
        <div className="mb-3">
          <span
            className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300"
            title="Confirmed BCH template"
            aria-label="Confirmed BCH template"
          >
            Confirmed BCH template
          </span>
        </div>
      ) : null}
      {flags.length === 0 ? (
        <div className="text-xs opacity-70">None</div>
      ) : (
        flags.map((f, i) => (
          <div key={`${f.key || i}`}>
            {f.key === "prev_hash_fork" && renderPrevHashFork()}
            {f.key === "invalid_coinbase_no_merkle" && renderInvalidTemplates(f)}
          </div>
        ))
      )}
    </div>
  );
}
