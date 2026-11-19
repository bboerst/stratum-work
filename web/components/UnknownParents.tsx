"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import { Info } from "lucide-react";
import { useElementWidth } from "@/visuals/framework/useElementWidth";
import { laneSegments, layoutTimeline, timeX } from "./unknown-parents/layout";

/**
 * Unknown parents (/api/unknown-parents): templates built on a block we don't know, as episodes (one per parent), over
 * the last 90 days, the last year or all history. The server aggregates, reads the facts, infers the kind and decodes;
 * this component draws the episodes (timeline, table) and one episode's pools as swimlanes. How the kinds are inferred is in
 * docs/methodology.md (linked from the header), not on the page.
 */

type Kind = "bitcoin_block" | "other_chain" | "invalid_parent" | "undetermined";
type ParentLabel = "best" | "stale" | "this" | "other";
type Range = "90d" | "1y" | "all";

interface Episode {
  parent: string;
  height: number;
  heights: number[];
  pools: { pool: string; connections: string[]; templates: number }[];
  first_ms: number;
  last_ms: number;
  duration_ms: number;
  templates: number;
  auxpow_templates: number;
  auxpow_share: number;
  facts: {
    tip_at_first: number | null;
    tip_offset: number | null;
    nbits: string[];
    bitcoin_bits: string | null;
    bitcoin_bits_at: string | null;
    bitcoin_difficulty: boolean | null;
    pow_ok: boolean;
    pow_bits: string;
    in_stale_blocks: boolean;
  };
  kind: Kind;
}

interface SummaryResponse {
  enabled: boolean;
  supported: boolean;
  range?: Range;
  days?: number | null;
  window_start?: number;
  generated_at?: number;
  episodes?: Episode[];
  error?: string;
}

interface Output { value: number; address?: string; protocol?: string; script_hex: string }

interface Template {
  id: string;
  pool_name: string;
  parent: ParentLabel;
  connections: string[];
  height: number;
  received_at: number;
  copies: number;
  prev_hash: string;
  version: string;
  nbits: string;
  ntime: string;
  clean_jobs: boolean;
  extranonce1: string;
  extranonce2_length: number;
  merkle_branches: number;
  coinbase_ok: boolean;
  coinbase_error?: string;
  scriptsig_height: number | null;
  coinbase_tags: string;
  auxpow: boolean;
  auxpow_root: string | null;
  auxpow_merkle_size: number | null;
  outputs: Output[];
  output_total: number;
}

interface DrillResponse {
  from_ms?: number;
  to_ms?: number;
  templates?: Template[];
  truncated?: boolean;
  blocks?: { hash: string; height: number; arrival_ms: number; best: boolean }[];
  error?: string;
}

const METHODOLOGY = "https://github.com/bboerst/stratum-work/blob/main/docs/methodology.md#unknown-parents";

const KINDS: Kind[] = ["bitcoin_block", "other_chain", "invalid_parent", "undetermined"];
const RANGES: Range[] = ["90d", "1y", "all"];
const RANGE_LABEL: Record<Range, string> = { "90d": "90d", "1y": "1y", all: "All" };
const RANGE_TEXT: Record<Range, string> = { "90d": "last 90 days", "1y": "last year", all: "all history" };
const KIND_LABEL: Record<Kind, string> = {
  bitcoin_block: "Bitcoin block",
  other_chain: "Other chain",
  invalid_parent: "Invalid",
  undetermined: "Undetermined",
};
// Validated categorical colours (light / dark): amber = Bitcoin, violet = another chain, rose = invalid
const KIND_FILL: Record<Kind, string> = {
  bitcoin_block: "fill-amber-600",
  other_chain: "fill-violet-600 dark:fill-violet-500",
  invalid_parent: "fill-rose-600 dark:fill-rose-500",
  undetermined: "fill-gray-500",
};
const KIND_BG: Record<Kind, string> = {
  bitcoin_block: "bg-amber-600",
  other_chain: "bg-violet-600 dark:bg-violet-500",
  invalid_parent: "bg-rose-600 dark:bg-rose-500",
  undetermined: "bg-gray-500",
};
// Drill-in: the episode's own parent in the text colour (the subject), amber = our best chain (as in the fork view),
// blue = a known stale block, gray = another unknown parent
const LABELS: ParentLabel[] = ["this", "best", "stale", "other"];
const LABEL_TEXT: Record<ParentLabel, string> = { this: "this parent", best: "best chain", stale: "stale", other: "other" };
const LABEL_FILL: Record<ParentLabel, string> = {
  this: "fill-foreground",
  best: "fill-amber-600",
  stale: "fill-[#1550a4] dark:fill-blue-500",
  other: "fill-gray-400 dark:fill-gray-500",
};
const LABEL_BG: Record<ParentLabel, string> = {
  this: "bg-foreground",
  best: "bg-amber-600",
  stale: "bg-[#1550a4] dark:bg-blue-500",
  other: "bg-gray-400 dark:bg-gray-500",
};

const fmtInt = (n: number) => n.toLocaleString("en-US");
const fmtUtc = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);
const fmtUtcS = (ms: number) => new Date(ms).toISOString().slice(11, 19);
const fmtLocal = (ms: number) => `${new Date(ms).toLocaleString()} (local)`;
function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 90) return `${Math.max(1, Math.round(s))}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

/** A pool name that fits the lane labels (about 7 px per character at 12 px). */
const shortName = (p: string, narrow: boolean) => {
  const max = narrow ? 9 : 16;
  return p.length > max ? `${p.slice(0, max - 1)}…` : p;
};

/** One-line summary of the facts the kind rests on, for tooltips. */
function factsTitle(e: Episode): string {
  const f = e.facts;
  return [
    `${KIND_LABEL[e.kind]} (inferred)`,
    `proof of work ${f.pow_ok ? "✓" : "✗"} (bits ${f.pow_bits})`,
    `Bitcoin difficulty ${f.bitcoin_difficulty === null ? "?" : f.bitcoin_difficulty ? "✓" : "✗"}`,
    `${f.tip_offset === null ? "no tip" : f.tip_offset === 0 ? "at our tip" : `${f.tip_offset > 0 ? "+" : ""}${fmtInt(f.tip_offset)} from our tip`}`,
  ].join(" · ");
}

function KindChip({ kind, title }: { kind: Kind; title?: string }) {
  return (
    <span title={title ?? "Inferred"} className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${KIND_BG[kind]}`} aria-hidden />
      {KIND_LABEL[kind]}
    </span>
  );
}

function PoolChips({ e, max = 6 }: { e: Episode; max?: number }) {
  const shown = e.pools.slice(0, max);
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map(p => (
        <span key={p.pool} className="rounded bg-foreground/10 px-1.5 py-0.5 text-[11px] whitespace-nowrap"
          title={`${fmtInt(p.templates)} templates · connection ${p.connections.join(", ")}`}>
          {p.pool}
        </span>
      ))}
      {e.pools.length > max && <span className="px-1 py-0.5 text-[11px] text-foreground/60">+{e.pools.length - max}</span>}
    </div>
  );
}

function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute z-10 rounded-md border border-border bg-background/95 px-2.5 py-1.5 text-xs shadow-lg"
      style={{ left: Math.max(0, Math.min(x, width - 190)), top: y, width: 190 }}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Timeline

const ROW_H = 24;
const MARK_H = 16;
const AXIS_H = 20;

function EpisodeTimeline({ episodes, start, end, selected, onSelect }: {
  episodes: Episode[]; start: number; end: number; selected: string | null; onSelect: (p: string) => void;
}) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const labelW = width < 520 ? 76 : 120;
  const plotW = Math.max(50, width - labelW - 8);
  const layout = useMemo(() => layoutTimeline(episodes, start, end, plotW, 5), [episodes, start, end, plotW]);
  const byParent = useMemo(() => new Map(episodes.map(e => [e.parent, e])), [episodes]);
  const [hover, setHover] = useState<{ parent: string; x: number; y: number } | null>(null);
  const ticks = useMemo(() => {
    const s = d3.scaleUtc().domain([start, end]).range([0, plotW]);
    // months up to about four months, then quarters (the year at January), then years
    const days = (end - start) / 86_400_000;
    const every = days <= 130 ? d3.utcMonth.every(1)! : days <= 800 ? d3.utcMonth.every(3)! : d3.utcYear.every(1)!;
    const label = (d: Date) => days > 800 || (days > 130 && d.getUTCMonth() === 0) ? d3.utcFormat("%Y")(d) : d3.utcFormat("%b")(d);
    return s.ticks(every).map(d => ({ x: s(d), label: label(d) }));
  }, [start, end, plotW]);
  const h = layout.pools.length * ROW_H + AXIS_H;
  const hovered = hover ? byParent.get(hover.parent) : null;

  return (
    <div ref={ref} className="relative w-full">
      <svg width={width} height={h} role="img" className="block text-foreground/60">
        <desc>One row per pool over {Math.round((end - start) / 86_400_000)} days; a mark per episode, as wide as it lasted, coloured by its inferred kind.</desc>
        <g transform={`translate(${labelW},0)`}>
          {ticks.map(t => (
            <g key={t.x}>
              <line x1={t.x} x2={t.x} y1={0} y2={h - AXIS_H} stroke="currentColor" strokeOpacity={0.12} />
              <text x={t.x + 3} y={h - 5} fontSize={11} fill="currentColor">{t.label}</text>
            </g>
          ))}
          {layout.marks.map((m, i) => (
            <g key={i} className="cursor-pointer" data-episode={m.parent}
              onMouseEnter={() => setHover({ parent: m.parent, x: labelW + m.x, y: (m.row + 1) * ROW_H + 4 })}
              onMouseLeave={() => setHover(null)}
              onClick={() => onSelect(m.parent)}>
              <rect x={m.x - 4} y={m.row * ROW_H} width={m.w + 8} height={ROW_H} fill="transparent" />
              <rect x={m.x} y={m.row * ROW_H + (ROW_H - MARK_H) / 2} width={m.w} height={MARK_H} rx={2}
                className={`${KIND_FILL[m.kind as Kind] ?? KIND_FILL.undetermined} ${selected === m.parent ? "stroke-foreground" : ""}`}
                strokeWidth={selected === m.parent ? 2 : 0}
                opacity={selected && selected !== m.parent ? 0.35 : 1} />
            </g>
          ))}
        </g>
        {layout.pools.map((p, i) => (
          <text key={p} x={labelW - 8} y={i * ROW_H + ROW_H / 2 + 4} fontSize={12} textAnchor="end" className="fill-foreground/60">
            <title>{p}</title>{shortName(p, labelW < 100)}
          </text>
        ))}
      </svg>
      {hovered && hover && (
        <Tooltip x={hover.x} y={hover.y} width={width}>
          <KindChip kind={hovered.kind} />
          <div className="mt-1 font-mono">{fmtInt(hovered.height)}</div>
          <div className="text-foreground/60">{hovered.pools.length} pool{hovered.pools.length > 1 ? "s" : ""} · {fmtDuration(hovered.duration_ms)}</div>
        </Tooltip>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Table

type SortKey = "time" | "height" | "pools" | "duration" | "kind";

function sortValue(e: Episode, k: SortKey): number {
  switch (k) {
    case "time": return e.first_ms;
    case "height": return e.height;
    case "pools": return e.pools.length;
    case "duration": return e.duration_ms;
    case "kind": return KINDS.indexOf(e.kind);
  }
}

function EpisodeTable({ episodes, selected, onSelect }: { episodes: Episode[]; selected: string | null; onSelect: (p: string) => void }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "time", desc: true });
  const rows = useMemo(() => [...episodes].sort((a, b) => {
    const c = sortValue(a, sort.key) - sortValue(b, sort.key) || a.first_ms - b.first_ms;
    return sort.desc ? -c : c;
  }), [episodes, sort]);
  const head = (label: string, k: SortKey, right = false) => {
    const active = sort.key === k;
    return (
      <th className={`px-3 py-2 text-xs font-normal text-foreground/60 cursor-pointer select-none whitespace-nowrap ${right ? "text-right" : "text-left"}`}
        onClick={() => setSort({ key: k, desc: active ? !sort.desc : k !== "kind" })}
        aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}>
        {label}{active ? (sort.desc ? " ↓" : " ↑") : ""}
      </th>
    );
  };
  return (
    <>
      <ul className="md:hidden space-y-2">
        {rows.map(e => (
          <li key={e.parent}>
            <button type="button" onClick={() => onSelect(e.parent)} title={factsTitle(e)}
              className={`w-full rounded-lg border border-border px-3 py-2.5 text-left text-xs space-y-1.5 ${e.parent === selected ? "bg-foreground/10" : ""}`}>
              <div className="flex items-center justify-between gap-2">
                <KindChip kind={e.kind} title={factsTitle(e)} />
                <span className="text-foreground/60" title={fmtLocal(e.first_ms)}>{fmtUtc(e.first_ms)}</span>
              </div>
              <div className="font-mono text-sm">{fmtInt(e.height)} <span className="text-foreground/60 text-xs">· {fmtDuration(e.duration_ms)}</span></div>
              <PoolChips e={e} max={4} />
            </button>
          </li>
        ))}
      </ul>
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              {head("Time (UTC)", "time")}
              {head("Height", "height", true)}
              {head("Pools", "pools")}
              {head("Duration", "duration", true)}
              {head("Kind", "kind")}
            </tr>
          </thead>
          <tbody>
            {rows.map(e => (
              <tr key={e.parent} onClick={() => onSelect(e.parent)}
                className={`border-b border-border/60 cursor-pointer hover:bg-foreground/5 ${e.parent === selected ? "bg-foreground/10" : ""}`}>
                <td className="px-3 py-2.5 text-xs text-foreground/60 whitespace-nowrap" title={fmtLocal(e.first_ms)}>{fmtUtc(e.first_ms)}</td>
                <td className="px-3 py-2.5 font-mono text-right">{fmtInt(e.height)}</td>
                <td className="px-3 py-2.5"><PoolChips e={e} /></td>
                <td className="px-3 py-2.5 font-mono text-right text-xs">{fmtDuration(e.duration_ms)}</td>
                <td className="px-3 py-2.5"><KindChip kind={e.kind} title={factsTitle(e)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="py-6 text-center text-xs text-foreground/60">None.</p>}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Drill-in

const LANE_H = 22;
const BAR_H = 12;

function Swimlanes({ episode, drill }: { episode: Episode; drill: DrillResponse }) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const labelW = width < 520 ? 76 : 120;
  const plotW = Math.max(50, width - labelW - 16);
  const start = drill.from_ms!, end = drill.to_ms!;
  const pools = useMemo(() => episode.pools.map(p => p.pool), [episode]);
  // a run per parent block: the template's height tells the best-chain blocks apart (h - 2, h - 1, h)
  const segments = useMemo(() => laneSegments((drill.templates ?? []).map(t => ({ pool: t.pool_name, t: t.received_at, label: t.parent, key: t.height })),
    start, end, plotW, 2), [drill, start, end, plotW]);
  const lane = useMemo(() => new Map(pools.map((p, i) => [p, i])), [pools]);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const ticks = useMemo(() => {
    const s = d3.scaleUtc().domain([start, end]).range([0, plotW]);
    return s.ticks(Math.max(2, Math.min(6, Math.floor(plotW / 120)))).map(d => ({ x: s(d), label: d3.utcFormat("%H:%M")(d) }));
  }, [start, end, plotW]);
  const lanesH = pools.length * LANE_H;
  const top = 18;
  const h = top + lanesH + AXIS_H;
  const seg = hover ? segments[hover.i] : null;

  return (
    <div ref={ref} className="relative w-full">
      <svg width={width} height={h} role="img" className="block text-foreground/60">
        <desc>One lane per pool; bars show which parent the pool was building on over time, lines mark when the blocks at height − 1 and height reached us.</desc>
        <g transform={`translate(${labelW},${top})`}>
          {ticks.map(t => (
            <text key={t.x} x={t.x} y={lanesH + 15} fontSize={11} textAnchor="middle" fill="currentColor">{t.label}</text>
          ))}
          {segments.map((s, i) => {
            const row = lane.get(s.pool);
            if (row === undefined) return null;
            return (
              // a 2 px gap where the pool moved on, so runs on different blocks stay apart
              <rect key={i} x={s.x} y={row * LANE_H + (LANE_H - BAR_H) / 2} width={s.w > 6 ? s.w - 2 : s.w} height={BAR_H} rx={2}
                className={LABEL_FILL[s.label as ParentLabel]} opacity={hover && hover.i !== i ? 0.75 : 1}
                onMouseEnter={() => setHover({ i, x: labelW + s.x, y: top + (row + 1) * LANE_H + 2 })}
                onMouseLeave={() => setHover(null)} />
            );
          })}
          {(drill.blocks ?? []).map(b => {
            const label = b.height === episode.height - 1 ? "h−1" : "h";
            const before = b.arrival_ms < start, after = b.arrival_ms > end;
            const x = timeX(b.arrival_ms, start, end, plotW);
            const cls = b.best ? "text-amber-600" : "text-[#1550a4] dark:text-blue-500";
            return (
              <g key={b.hash} className={cls}>
                <title>{`${label}${b.best ? "" : " (stale)"} ${fmtInt(b.height)} · ${fmtUtcS(b.arrival_ms)} UTC`}</title>
                {!before && !after && <line x1={x} x2={x} y1={-4} y2={lanesH} stroke="currentColor" strokeWidth={1.5} />}
                <text x={before ? 0 : after ? plotW : x} y={-6} fontSize={11} fill="currentColor"
                  textAnchor={after ? "end" : before ? "start" : "middle"}>
                  {before ? `‹ ${label}` : after ? `${label} ›` : label}
                </text>
              </g>
            );
          })}
        </g>
        {pools.map((p, i) => (
          <text key={p} x={labelW - 8} y={top + i * LANE_H + LANE_H / 2 + 4} fontSize={12} textAnchor="end" className="fill-foreground/60">
            <title>{p}</title>{shortName(p, labelW < 100)}
          </text>
        ))}
      </svg>
      {seg && hover && (
        <Tooltip x={hover.x} y={hover.y} width={width}>
          <div className="flex items-center gap-1.5">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${LABEL_BG[seg.label as ParentLabel]}`} aria-hidden />
            {LABEL_TEXT[seg.label as ParentLabel]}
          </div>
          <div className="mt-1 text-foreground/60">{seg.pool} · {seg.n} template{seg.n > 1 ? "s" : ""}</div>
          <div className="font-mono text-foreground/60">{fmtUtcS(seg.from)}{seg.to > seg.from ? `–${fmtUtcS(seg.to)}` : ""}</div>
        </Tooltip>
      )}
    </div>
  );
}

function TemplateRow({ t }: { t: Template }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="border-b border-border/60 hover:bg-foreground/5 cursor-pointer" onClick={() => setOpen(o => !o)}>
        <td className="px-3 py-1.5 font-mono text-xs" title={fmtLocal(t.received_at)}>{fmtUtcS(t.received_at)}</td>
        <td className="px-3 py-1.5 text-xs whitespace-nowrap">{t.pool_name} <span className="text-foreground/60">{t.connections.join("/")}</span></td>
        <td className="px-3 py-1.5" title={LABEL_TEXT[t.parent]}><span className={`inline-block h-2.5 w-2.5 rounded-full ${LABEL_BG[t.parent]}`} /></td>
        <td className="px-3 py-1.5 font-mono text-xs text-foreground/60">{t.nbits}</td>
      </tr>
      {open && (
        <tr className="border-b border-border/60 bg-foreground/5">
          <td colSpan={4} className="px-3 py-2 text-xs">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 font-mono break-all">
              <dt className="text-foreground/60">height</dt><dd>{fmtInt(t.height)}</dd>
              <dt className="text-foreground/60">prev hash</dt><dd>{t.prev_hash}</dd>
              <dt className="text-foreground/60">coinbase</dt><dd>{t.coinbase_tags || "—"}{t.auxpow ? " · AuxPoW" : ""}</dd>
              <dt className="text-foreground/60">outputs</dt>
              <dd>{t.outputs.slice(0, 4).map((o, i) => (
                <div key={i}>{(o.value / 1e8).toFixed(8)} → {o.address ?? (o.protocol ? `OP_RETURN ${o.protocol}` : `${o.script_hex.slice(0, 40)}…`)}</div>
              ))}{t.outputs.length > 4 ? <div className="text-foreground/60">+{t.outputs.length - 4}</div> : null}</dd>
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

const LIST_PAGE = 200;

function DrillIn({ episode, range }: { episode: Episode; range: Range }) {
  const [drill, setDrill] = useState<{ parent: string; data: DrillResponse } | null>(null);
  const [showList, setShowList] = useState(false);
  const [shown, setShown] = useState(LIST_PAGE);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const ctl = new AbortController();
    fetch(`/api/unknown-parents?parent=${episode.parent}&range=${range}`, { signal: ctl.signal })
      .then(r => r.json())
      .then((d: DrillResponse) => setDrill({ parent: episode.parent, data: d }))
      .catch(e => { if (e?.name !== "AbortError") setDrill({ parent: episode.parent, data: { error: String(e) } }); });
    return () => ctl.abort();
  }, [episode.parent, range]);
  const data = drill?.parent === episode.parent ? drill.data : null;
  const templates = useMemo(() => data?.templates ?? [], [data]);
  const present = useMemo(() => new Set(templates.map(t => t.parent)), [templates]);

  return (
    <section className="mt-8 rounded-xl border border-border p-4" aria-label="Episode details">
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <KindChip kind={episode.kind} title={factsTitle(episode)} />
        <span className="font-mono text-base">{fmtInt(episode.height)}</span>
        <button type="button" className="font-mono text-xs text-foreground/60 hover:text-foreground"
          title={`${episode.parent} · click to copy`}
          onClick={() => navigator.clipboard?.writeText(episode.parent).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }, () => {})}>
          {copied ? "copied" : `${episode.parent.slice(0, 6)}…${episode.parent.slice(-6)}`}
        </button>
        <span className="text-xs text-foreground/60">{episode.pools.length} pool{episode.pools.length > 1 ? "s" : ""}</span>
        <span className="text-xs text-foreground/60">{fmtDuration(episode.duration_ms)}</span>
        <span className="text-xs text-foreground/60" title={factsTitle(episode)}>
          PoW {episode.facts.pow_ok ? "✓" : "✗"}
        </span>
        <span className="ml-auto flex flex-wrap gap-3 text-xs text-foreground/60">
          {LABELS.filter(l => present.has(l)).map(l => (
            <span key={l} className="inline-flex items-center gap-1.5">
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${LABEL_BG[l]}`} aria-hidden />{LABEL_TEXT[l]}
            </span>
          ))}
        </span>
      </div>
      {!data && <p className="py-8 text-center text-xs text-foreground/60">Loading…</p>}
      {data?.error && <p className="text-sm text-red-500">{data.error}</p>}
      {data && !data.error && (
        <>
          <Swimlanes episode={episode} drill={data} />
          <button type="button" className="mt-4 text-xs text-foreground/60 hover:text-foreground"
            onClick={() => setShowList(s => !s)} aria-expanded={showList}>
            {showList ? "▾" : "▸"} Templates ({fmtInt(templates.length)}{data.truncated ? "+" : ""})
          </button>
          {showList && (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>{templates.slice(0, shown).map(t => <TemplateRow key={t.id} t={t} />)}</tbody>
              </table>
              {templates.length > shown && (
                <button className="mt-2 text-xs text-foreground/60 hover:text-foreground" onClick={() => setShown(s => s + LIST_PAGE)}>
                  more ({fmtInt(templates.length - shown)})
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

/** Keep a choice in the page's URL (shareable), without a navigation. */
function setUrl(key: string, value: string | null) {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(key); else url.searchParams.set(key, value);
  window.history.replaceState(null, "", url);
}

export default function UnknownParents() {
  const [range, setRange] = useState<Range>("90d");
  // the last summary read, with its range: shown only while that range is chosen (a late answer for another range
  // never replaces the chosen one's)
  const [loaded, setLoaded] = useState<{ range: Range; data: SummaryResponse } | null>(null);
  const [kind, setKind] = useState<Kind | "all">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const detailsRef = useRef<HTMLDivElement>(null);

  const load = useCallback((r: Range) => fetch(`/api/unknown-parents?range=${r}`)
    .then(res => res.json())
    .then((d: SummaryResponse) => setLoaded({ range: r, data: d }))
    .catch(e => setLoaded({ range: r, data: { enabled: true, supported: true, error: String(e) } })), []);

  useEffect(() => {
    // a shared link's range and episode (?range=…&parent=…)
    const q = new URLSearchParams(window.location.search);
    const r = RANGES.find(x => x === q.get("range")) ?? "90d";
    const p = q.get("parent");
    load(r).then(() => {
      setRange(r);
      if (p && /^[0-9a-f]{64}$/i.test(p)) setSelected(p.toLowerCase());
    });
  }, [load]);
  const summary = loaded?.range === range ? loaded.data : null;

  const select = useCallback((parent: string) => {
    setSelected(parent);
    setUrl("parent", parent);
    requestAnimationFrame(() => detailsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);
  const chooseRange = (r: Range) => {
    if (r === range) return;
    setRange(r);
    setUrl("range", r === "90d" ? null : r);
    load(r);
  };

  const all = useMemo(() => summary?.episodes ?? [], [summary]);
  const episodes = useMemo(() => (kind === "all" ? all : all.filter(e => e.kind === kind)), [all, kind]);
  const counts = useMemo(() => {
    const c: Partial<Record<Kind, number>> = {};
    for (const e of all) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [all]);
  const selectedEpisode = all.find(e => e.parent === selected) ?? null;

  const shownRange = range;
  const rangePicker = (
    <div className="ml-auto inline-flex overflow-hidden rounded-full border border-border text-xs" role="group" aria-label="Range">
      {RANGES.map(r => (
        <button key={r} onClick={() => chooseRange(r)} aria-pressed={shownRange === r}
          className={`px-3 py-1.5 transition-colors ${shownRange === r ? "bg-foreground/10" : "text-foreground/60 hover:bg-foreground/5"}`}>
          {RANGE_LABEL[r]}
        </button>
      ))}
    </div>
  );

  let body: React.ReactNode;
  if (!summary) body = (
    <>
      <div className="mb-5 flex">{rangePicker}</div>
      <p className="py-12 text-center text-sm text-foreground/60">Loading…</p>
    </>
  );
  else if (summary.error) body = <p className="text-sm text-red-500">{summary.error}</p>;
  else if (!summary.enabled) body = <p className="text-sm text-foreground/60">Historical data is disabled on this deployment.</p>;
  else body = (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-2" role="group" aria-label="Filter by kind">
        {(["all", ...KINDS] as const).filter(k => k === "all" || counts[k]).map(k => (
          <button key={k} onClick={() => setKind(k)} aria-pressed={kind === k}
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors ${kind === k ? "border-foreground/60 bg-foreground/10" : "border-border hover:bg-foreground/5"}`}>
            {k !== "all" && <span className={`inline-block h-2.5 w-2.5 rounded-full ${KIND_BG[k]}`} aria-hidden />}
            {k === "all" ? "All" : KIND_LABEL[k]}
            <span className="font-mono text-foreground/60">{k === "all" ? all.length : counts[k]}</span>
          </button>
        ))}
        {rangePicker}
      </div>
      {all.length > 0 && summary.window_start && summary.generated_at && (
        <div className="mb-8 rounded-xl border border-border p-4">
          <EpisodeTimeline episodes={episodes} start={summary.window_start} end={summary.generated_at}
            selected={selected} onSelect={select} />
        </div>
      )}
      <div ref={detailsRef} className="scroll-mt-4">
        {selectedEpisode && <DrillIn key={selectedEpisode.parent} episode={selectedEpisode} range={shownRange} />}
      </div>
      <div className="mt-8">
        <EpisodeTable episodes={episodes} selected={selected} onSelect={select} />
      </div>
    </>
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-5">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          Unknown parents
          <a href={METHODOLOGY} target="_blank" rel="noreferrer" title="How the kinds are inferred"
            className="text-foreground/60 hover:text-foreground" aria-label="Methodology">
            <Info className="h-4 w-4" />
          </a>
        </h1>
        <p className="mt-1 text-sm text-foreground/60">Templates built on a block we don&apos;t know · {RANGE_TEXT[shownRange]}</p>
      </div>
      {body}
    </div>
  );
}
