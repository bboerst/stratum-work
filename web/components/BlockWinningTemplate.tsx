"use client";

import React, { useEffect, useState } from "react";
import { useLatencyAdjusted } from "./TimingDisplayContext";
import { matchTimeMs, type BlockMatches, type CoinbaseFit } from "@/lib/blockTemplateMatches";

/**
 * The height page's "Winning template" (#235): which stored jobs carried exactly this block's transactions, proven by
 * the block's merkle path (/api/block-template-matches). A match identifies the job's transaction set, not who mined
 * the block, so every match is listed (same encoding for every pool) next to the block's own identification.
 */

const FIT_LABEL: Record<CoinbaseFit, string> = { coinbase: "coinbase", layout: "layout", merkle: "set only" };
const FIT_TITLE: Record<CoinbaseFit, string> = {
  coinbase: "the block's coinbase starts with this template's coinbase1 and ends with its coinbase2",
  layout: "the coinbase brackets differ, but the bytes between them are exactly this template's extranonce length",
  merkle: "the same transactions; the coinbase isn't this template's",
};
const FIT_CLASS: Record<CoinbaseFit, string> = {
  coinbase: "bg-emerald-600 text-white dark:bg-emerald-500",
  layout: "bg-emerald-600/20 text-emerald-700 dark:text-emerald-300",
  merkle: "bg-foreground/10 text-foreground/70",
};

const fmtInt = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, w: string) => `${fmtInt(n)} ${w}${n === 1 ? "" : "s"}`;

function utc(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
}

function before(ms: number): string {
  const s = ms / 1000;
  return s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${s.toFixed(s < 10 ? 2 : 1)}s`;
}

function Verified({ block, adjusted }: { block: BlockMatches; adjusted: boolean }) {
  const pools = new Set(block.matches.map(m => m.pool)).size;
  return (
    <div className="text-xs">
      <p className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded-sm bg-emerald-600 px-1.5 py-0.5 font-medium text-white dark:bg-emerald-500"
          title="verified: the block's merkle path equals these templates' merkle branches, so they carried exactly its transactions">
          ✓ Verified
        </span>
        <span className="text-foreground/70">its transactions were in jobs from {plural(pools, "pool")}</span>
      </p>
      <table className="w-full max-w-xl text-left">
        <thead className="text-foreground/50">
          <tr>
            <th className="py-0.5 pr-3 font-normal">Pool</th>
            <th className="py-0.5 pr-3 font-normal" title="our connection to the pool">Conn</th>
            <th className="py-0.5 pr-3 font-normal" title={`first received (UTC)${adjusted ? ", latency adjusted" : ""}`}>First</th>
            {block.seen_ms !== null && <th className="py-0.5 pr-3 font-normal" title="how long before the block reached our node">Before block</th>}
            <th className="py-0.5 font-normal">Coinbase</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {block.matches.map(m => ({ m, t: matchTimeMs(m, adjusted) })).sort((x, y) => x.t - y.t).map(({ m, t }) => {
            return (
              <tr key={`${m.pool}/${m.connection}/${m.first_us}`} className="border-t border-foreground/10">
                <td className="py-0.5 pr-3 font-sans">{m.pool}</td>
                <td className="py-0.5 pr-3">{m.connection}</td>
                <td className="py-0.5 pr-3" title={`${plural(m.templates, "template")} with this set${adjusted && m.lat_ms === null ? " · no latency estimate: unadjusted" : ""}`}>{utc(t)}</td>
                {block.seen_ms !== null && <td className="py-0.5 pr-3">{block.seen_ms >= t ? before(block.seen_ms - t) : "after"}</td>}
                <td className="py-0.5 font-sans">
                  {m.coinbase
                    ? <span className={`rounded-sm px-1 ${FIT_CLASS[m.coinbase]}`} title={FIT_TITLE[m.coinbase]}>{FIT_LABEL[m.coinbase]}</span>
                    : <span className="text-foreground/40" title="the block's coinbase bytes aren't stored">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-foreground/50"
        title="unrelated pools can send the same transaction set: a match identifies the job's transactions, not who mined the block">
        Mined by {block.pool ?? "an unidentified pool"} (from its coinbase)
      </p>
    </div>
  );
}

function Other({ block }: { block: BlockMatches }) {
  if (block.state === "unknown") return <p className="text-xs text-foreground/60">Not checked yet: this block&apos;s merkle path isn&apos;t stored.</p>;
  if (block.state === "empty_block") return <p className="text-xs text-foreground/60">Empty block: any empty template has its transactions, so nothing is proven.</p>;
  return (
    <div className="text-xs text-foreground/70">
      <p title="the pool isn't one we collect, the job was never sent to our connections, or our collection had a gap">
        No stored template has this block&apos;s transactions.
      </p>
      {block.closest && (
        <p className="mt-1 text-[11px] text-foreground/50">
          Closest: the first {plural(block.closest.transactions, "transaction")} agree, in jobs from {block.closest.pools.join(", ")}
        </p>
      )}
    </div>
  );
}

export default function BlockWinningTemplate({ height }: { height: number }) {
  // the response for one height; a height that doesn't match is still loading (no reset inside the effect)
  const [got, setGot] = useState<{ height: number; data: { blocks: BlockMatches[] } | null } | null>(null);
  const [adjusted] = useLatencyAdjusted("timing-chart");
  useEffect(() => {
    const ctl = new AbortController();
    fetch(`/api/block-template-matches?height=${height}`, { signal: ctl.signal })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => setGot({ height, data: d }))
      .catch(e => { if (!ctl.signal.aborted) { console.error("Error reading template matches:", e); setGot({ height, data: null }); } });
    return () => ctl.abort();
  }, [height]);
  if (!got || got.height !== height) return <div className="h-16 animate-pulse rounded-sm bg-foreground/5" />;
  const data = got.data;
  if (!data) return <p className="py-2 text-xs text-foreground/60">Template matches unavailable.</p>;
  if (!data.blocks?.length) return <p className="py-2 text-xs text-foreground/60">No block stored at this height.</p>;
  return (
    <div className="space-y-3 py-1">
      {data.blocks.map(b => (
        <div key={b.hash}>
          {data.blocks.length > 1 && <p className="mb-1 font-mono text-[11px] text-foreground/50">{b.hash}</p>}
          {b.state === "verified" ? <Verified block={b} adjusted={adjusted} /> : <Other block={b} />}
        </div>
      ))}
    </div>
  );
}
