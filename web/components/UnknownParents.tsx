"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import { useElementWidth } from "@/visuals/framework/useElementWidth";
import { lanePaths, layoutTimeline, nearestIndex, timeX } from "./unknown-parents/layout";

/**
 * The "Unknown parents" view (/api/unknown-parents): templates of the last 90 days whose previous block is no block we
 * know, as episodes (one per parent). The server does the aggregation, the facts, the inferred kind and the decoding;
 * this component lays out a few dozen episodes (timeline, table) and one episode's templates (swimlanes, list).
 */

type Kind = "bitcoin_block" | "other_chain" | "invalid_parent" | "undetermined";
type ParentLabel = "best" | "stale" | "this" | "other";

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
  days?: number;
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
  episode?: Episode;
  from_ms?: number;
  to_ms?: number;
  templates?: Template[];
  truncated?: boolean;
  blocks?: { hash: string; height: number; arrival_ms: number; best: boolean }[];
  error?: string;
}

const KINDS: Kind[] = ["bitcoin_block", "other_chain", "invalid_parent", "undetermined"];
const KIND_LABEL: Record<Kind, string> = {
  bitcoin_block: "Unrecorded Bitcoin block",
  other_chain: "Another chain",
  invalid_parent: "Invalid parent",
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
const LABEL_TEXT: Record<ParentLabel, string> = {
  this: "this unknown parent",
  best: "a best-chain block",
  stale: "a stale block",
  other: "another unknown parent",
};
// Drill-in: the episode's own parent in the text colour (the subject), amber = our best chain (as in the fork view),
// blue = a known stale block, gray = another unknown parent
const LABEL_STROKE: Record<ParentLabel, string> = {
  this: "stroke-foreground",
  best: "stroke-amber-600",
  stale: "stroke-[#1550a4] dark:stroke-blue-500",
  other: "stroke-gray-400 dark:stroke-gray-500",
};
const LABEL_BG: Record<ParentLabel, string> = {
  this: "bg-foreground",
  best: "bg-amber-600",
  stale: "bg-[#1550a4] dark:bg-blue-500",
  other: "bg-gray-400 dark:bg-gray-500",
};
const LABELS: ParentLabel[] = ["this", "best", "stale", "other"];

const fmtInt = (n: number) => n.toLocaleString("en-US");
const fmtUtc = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const fmtLocal = (ms: number) => `${new Date(ms).toLocaleString()} (your time)`;
function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 1) return `${Math.round(ms)} ms`;
  if (s < 90) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  if (s < 5400) return `${(s / 60).toFixed(1)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}
const fmtOffset = (o: number | null) => (o === null ? "—" : o === 0 ? "at tip" : `${o > 0 ? "+" : "−"}${fmtInt(Math.abs(o))}`);
const NEAR_TIP = 1;

function Time({ ms }: { ms: number }) {
  return <span title={fmtLocal(ms)} className="font-mono whitespace-nowrap">{fmtUtc(ms)}</span>;
}

function KindChip({ kind }: { kind: Kind }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] whitespace-nowrap"
      title="Inferred from the facts in this row, not stored">
      <span className={`inline-block h-2 w-2 rounded-full ${KIND_BG[kind]}`} aria-hidden />
      {KIND_LABEL[kind]}
      <span className="text-muted-foreground">inferred</span>
    </span>
  );
}

function Badge({ ok, children, title }: { ok: boolean | null; children: React.ReactNode; title: string }) {
  const cls = ok === null ? "text-muted-foreground border-dashed" : ok ? "" : "text-muted-foreground";
  return (
    <span title={title} className={`inline-block rounded border border-border px-1.5 py-0.5 text-[11px] whitespace-nowrap ${cls}`}>
      {ok === null ? "?" : ok ? "✓" : "✗"} {children}
    </span>
  );
}

function Evidence({ e }: { e: Episode }) {
  const f = e.facts;
  const near = f.tip_offset !== null && Math.abs(f.tip_offset) <= NEAR_TIP;
  return (
    <div className="flex flex-wrap gap-1">
      <Badge ok={f.pow_ok} title={`The parent hash as a number ${f.pow_ok ? "is" : "is not"} at or below the target of bits ${f.pow_bits} (${f.bitcoin_bits ? "Bitcoin's at height − 1" : "the templates' own nbits: no Bitcoin block stored at height − 1"})`}>
        {f.pow_ok ? "meets PoW" : "fails PoW"}
      </Badge>
      <Badge ok={f.bitcoin_difficulty} title={`Templates' nbits ${f.nbits.join(", ")}; Bitcoin's bits at height − 1: ${f.bitcoin_bits ?? "no block stored, nothing to compare with"}`}>
        {f.bitcoin_difficulty === null ? "no Bitcoin block" : f.bitcoin_difficulty ? "Bitcoin difficulty" : "other difficulty"}
      </Badge>
      <Badge ok={f.tip_offset === null ? null : near} title={`Height − 1 − our tip when the first template arrived (tip ${f.tip_at_first === null ? "unknown" : fmtInt(f.tip_at_first)})`}>
        {f.tip_offset === null ? "no tip" : near ? (f.tip_offset === 0 ? "at tip" : `tip ${fmtOffset(f.tip_offset)}`) : "far from tip"}
      </Badge>
      <Badge ok={f.in_stale_blocks} title={f.in_stale_blocks ? "Our node recorded the parent as a stale block" : "Our node never recorded the parent as a block (not even stale)"}>
        {f.in_stale_blocks ? "recorded stale" : "unrecorded"}
      </Badge>
    </div>
  );
}

function PoolChips({ e }: { e: Episode }) {
  return (
    <div className="flex flex-wrap gap-1">
      {e.pools.map(p => (
        <span key={p.pool} className="rounded bg-muted px-1.5 py-0.5 text-[11px] whitespace-nowrap"
          title={`${fmtInt(p.templates)} templates on connection${p.connections.length > 1 ? "s" : ""} ${p.connections.join(", ")}`}>
          {p.pool} <span className="text-muted-foreground">{p.connections.join("/")}</span>
        </span>
      ))}
    </div>
  );
}

function CopyHash({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" title={`${hash} (click to copy)`} className="font-mono text-xs hover:underline"
      onClick={ev => {
        ev.stopPropagation();
        navigator.clipboard?.writeText(hash).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }, () => {});
      }}>
      {copied ? "copied" : `${hash.slice(0, 8)}…${hash.slice(-8)}`}
    </button>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Timeline

const ROW_H = 20;
const AXIS_H = 22;

function EpisodeTimeline({ episodes, start, end, selected, onSelect }: {
  episodes: Episode[]; start: number; end: number; selected: string | null; onSelect: (p: string) => void;
}) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const labelW = width < 520 ? 84 : 140;
  const plotW = Math.max(50, width - labelW - 8);
  const layout = useMemo(() => layoutTimeline(episodes, start, end, plotW, 3), [episodes, start, end, plotW]);
  const byParent = useMemo(() => new Map(episodes.map(e => [e.parent, e])), [episodes]);
  const [hover, setHover] = useState<{ parent: string; x: number; y: number } | null>(null);
  const ticks = useMemo(() => {
    const s = d3.scaleUtc().domain([start, end]).range([0, plotW]);
    return s.ticks(Math.max(2, Math.floor(plotW / 90))).map(d => ({ x: s(d), label: d3.utcFormat("%b %d")(d) }));
  }, [start, end, plotW]);
  const h = layout.pools.length * ROW_H + AXIS_H;
  const hovered = hover ? byParent.get(hover.parent) : null;

  return (
    <div ref={ref} className="relative w-full">
      <svg width={width} height={h} role="img" className="block text-muted-foreground">
        <desc>One row per pool over the last {Math.round((end - start) / 86_400_000)} days; a mark per episode, as wide as it lasted, coloured by its inferred kind.</desc>
        <g transform={`translate(${labelW},0)`}>
          {ticks.map(t => (
            <g key={t.x}>
              <line x1={t.x} x2={t.x} y1={0} y2={h - AXIS_H} stroke="currentColor" strokeOpacity={0.15} />
              <text x={t.x} y={h - 6} fontSize={10} textAnchor="middle" fill="currentColor">{t.label}</text>
            </g>
          ))}
          {layout.pools.map((_, i) => (
            <line key={i} x1={0} x2={plotW} y1={(i + 1) * ROW_H} y2={(i + 1) * ROW_H} stroke="currentColor" strokeOpacity={0.08} />
          ))}
          {layout.marks.map((m, i) => (
            <g key={i} className="cursor-pointer"
              onMouseEnter={() => setHover({ parent: m.parent, x: labelW + m.x + m.w / 2, y: m.row * ROW_H })}
              onMouseLeave={() => setHover(null)}
              onClick={() => onSelect(m.parent)}>
              <rect x={m.x - 3} y={m.row * ROW_H} width={m.w + 6} height={ROW_H} fill="transparent" />
              <rect x={m.x} y={m.row * ROW_H + 4} width={m.w} height={ROW_H - 8} rx={1.5}
                className={`${KIND_FILL[m.kind as Kind] ?? KIND_FILL.undetermined} ${selected === m.parent ? "stroke-foreground" : ""}`}
                strokeWidth={selected === m.parent ? 1.5 : 0}
                opacity={selected && selected !== m.parent ? 0.45 : 1} />
            </g>
          ))}
        </g>
        {layout.pools.map((p, i) => (
          <text key={p} x={labelW - 6} y={i * ROW_H + ROW_H / 2 + 4} fontSize={11} textAnchor="end" className="fill-foreground">
            {p.length > (labelW < 100 ? 11 : 20) ? `${p.slice(0, labelW < 100 ? 10 : 19)}…` : p}
          </text>
        ))}
      </svg>
      {hovered && hover && (
        <div className="pointer-events-none absolute z-10 rounded-md border border-border bg-background px-2 py-1 text-xs shadow"
          style={{ left: Math.min(hover.x, width - 220), top: hover.y + ROW_H + 2, width: 220 }}>
          <div className="font-medium">{KIND_LABEL[hovered.kind]} <span className="text-muted-foreground">(inferred)</span></div>
          <div>{fmtUtc(hovered.first_ms)} UTC · {fmtDuration(hovered.duration_ms)}</div>
          <div>height {fmtInt(hovered.height)} · {fmtOffset(hovered.facts.tip_offset)} · {fmtInt(hovered.templates)} templates</div>
          <div className="text-muted-foreground">{hovered.pools.length} pool{hovered.pools.length > 1 ? "s" : ""} · click for details</div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Table

type SortKey = "time" | "height" | "offset" | "pools" | "duration" | "templates" | "kind";

function SortHeader({ label, k, sort, setSort, align = "left" }: {
  label: string; k: SortKey; sort: { key: SortKey; desc: boolean }; setSort: (s: { key: SortKey; desc: boolean }) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === k;
  return (
    <th className={`p-2 text-xs font-medium text-muted-foreground cursor-pointer select-none whitespace-nowrap ${align === "right" ? "text-right" : "text-left"}`}
      onClick={() => setSort({ key: k, desc: active ? !sort.desc : k !== "kind" })}
      aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}>
      {label}{active ? (sort.desc ? " ▼" : " ▲") : ""}
    </th>
  );
}

function sortValue(e: Episode, k: SortKey): number | string {
  switch (k) {
    case "time": return e.first_ms;
    case "height": return e.height;
    case "offset": return e.facts.tip_offset === null ? Infinity : Math.abs(e.facts.tip_offset);
    case "pools": return e.pools.length;
    case "duration": return e.duration_ms;
    case "templates": return e.templates;
    case "kind": return KINDS.indexOf(e.kind);
  }
}

function EpisodeTable({ episodes, selected, onSelect }: { episodes: Episode[]; selected: string | null; onSelect: (p: string) => void }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "time", desc: true });
  const rows = useMemo(() => {
    const list = [...episodes];
    list.sort((a, b) => {
      const x = sortValue(a, sort.key), y = sortValue(b, sort.key);
      const c = x < y ? -1 : x > y ? 1 : a.first_ms - b.first_ms;
      return sort.desc ? -c : c;
    });
    return list;
  }, [episodes, sort]);
  return (
    <>
    {/* phones: one card per episode */}
    <div className="md:hidden">
      <label className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        Sort
        <select className="rounded border border-border bg-background px-1 py-0.5" value={`${sort.key}:${sort.desc ? "desc" : "asc"}`}
          onChange={ev => { const [key, dir] = ev.target.value.split(":"); setSort({ key: key as SortKey, desc: dir === "desc" }); }}>
          <option value="time:desc">newest first</option>
          <option value="time:asc">oldest first</option>
          <option value="pools:desc">most pools</option>
          <option value="duration:desc">longest</option>
          <option value="templates:desc">most templates</option>
          <option value="kind:asc">by kind</option>
        </select>
      </label>
      <ul className="space-y-2">
        {rows.map(e => (
          <li key={e.parent}>
            <button type="button" onClick={() => onSelect(e.parent)}
              className={`w-full rounded-lg border border-border p-2 text-left text-xs space-y-1 ${e.parent === selected ? "bg-muted" : ""}`}>
              <div className="flex flex-wrap items-center justify-between gap-1">
                <Time ms={e.first_ms} />
                <KindChip kind={e.kind} />
              </div>
              <div className="font-mono">
                height {fmtInt(e.height)} · {fmtOffset(e.facts.tip_offset)} · {fmtDuration(e.duration_ms)} · {fmtInt(e.templates)} templates
              </div>
              <div className="font-mono text-muted-foreground break-all">{e.parent.slice(0, 16)}…{e.parent.slice(-8)}</div>
              <PoolChips e={e} />
              <Evidence e={e} />
            </button>
          </li>
        ))}
        {rows.length === 0 && <li className="p-4 text-center text-muted-foreground text-xs">No episodes of this kind.</li>}
      </ul>
    </div>
    <div className="hidden md:block overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr>
            <SortHeader label="First template (UTC)" k="time" sort={sort} setSort={setSort} />
            <SortHeader label="Height" k="height" sort={sort} setSort={setSort} align="right" />
            <SortHeader label="From tip" k="offset" sort={sort} setSort={setSort} align="right" />
            <th className="p-2 text-xs font-medium text-muted-foreground text-left">Parent</th>
            <SortHeader label="Pools" k="pools" sort={sort} setSort={setSort} />
            <SortHeader label="Duration" k="duration" sort={sort} setSort={setSort} align="right" />
            <SortHeader label="Templates" k="templates" sort={sort} setSort={setSort} align="right" />
            <th className="p-2 text-xs font-medium text-muted-foreground text-left">Evidence</th>
            <SortHeader label="Kind" k="kind" sort={sort} setSort={setSort} />
          </tr>
        </thead>
        <tbody>
          {rows.map(e => (
            <tr key={e.parent} onClick={() => onSelect(e.parent)}
              className={`border-b border-border cursor-pointer hover:bg-muted/50 align-top ${e.parent === selected ? "bg-muted" : ""}`}>
              <td className="p-2 text-xs"><Time ms={e.first_ms} /></td>
              <td className="p-2 text-xs text-right font-mono" title={e.heights.length > 1 ? `heights ${e.heights.join(", ")}` : undefined}>
                {fmtInt(e.height)}{e.heights.length > 1 ? "*" : ""}
              </td>
              <td className="p-2 text-xs text-right font-mono whitespace-nowrap">{fmtOffset(e.facts.tip_offset)}</td>
              <td className="p-2"><CopyHash hash={e.parent} /></td>
              <td className="p-2 min-w-[8rem]"><PoolChips e={e} /></td>
              <td className="p-2 text-xs text-right font-mono whitespace-nowrap">{fmtDuration(e.duration_ms)}</td>
              <td className="p-2 text-xs text-right font-mono" title={e.auxpow_templates ? `${(e.auxpow_share * 100).toFixed(0)}% with an AuxPoW commitment` : undefined}>
                {fmtInt(e.templates)}
              </td>
              <td className="p-2 min-w-[17rem]"><Evidence e={e} /></td>
              <td className="p-2"><KindChip kind={e.kind} /></td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={9} className="p-4 text-center text-muted-foreground text-xs">No episodes of this kind.</td></tr>
          )}
        </tbody>
      </table>
    </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Drill-in

const LANE_H = 22;

function Swimlanes({ episode, drill }: { episode: Episode; drill: DrillResponse }) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const labelW = width < 520 ? 84 : 140;
  const plotW = Math.max(50, width - labelW - 12);
  const start = drill.from_ms!, end = drill.to_ms!;
  const pools = useMemo(() => episode.pools.map(p => p.pool), [episode]);
  const templates = useMemo(() => drill.templates ?? [], [drill]);
  const paths = useMemo(() => lanePaths(templates.map(t => ({ pool: t.pool_name, t: t.received_at, label: t.parent })),
    pools, start, end, plotW, LANE_H, LANE_H - 8), [templates, pools, start, end, plotW]);
  // per lane: the ticks' x (sorted, templates come earliest first) for the hover
  const laneTicks = useMemo(() => {
    const m = new Map<string, { xs: number[]; ts: Template[] }>();
    for (const t of templates) {
      const l = m.get(t.pool_name) ?? { xs: [], ts: [] };
      l.xs.push(timeX(t.received_at, start, end, plotW));
      l.ts.push(t);
      m.set(t.pool_name, l);
    }
    return m;
  }, [templates, start, end, plotW]);
  const [hover, setHover] = useState<{ t: Template; x: number; y: number } | null>(null);
  const ticks = useMemo(() => {
    const s = d3.scaleUtc().domain([start, end]).range([0, plotW]);
    return s.ticks(Math.max(2, Math.floor(plotW / 80))).map(d => ({ x: s(d), label: d3.utcFormat("%H:%M")(d) }));
  }, [start, end, plotW]);
  const blocks = (drill.blocks ?? []).filter(b => b.arrival_ms >= start && b.arrival_ms <= end);
  const lanesH = pools.length * LANE_H;
  const h = lanesH + AXIS_H + 16;

  const onMove = (ev: React.MouseEvent<SVGRectElement>) => {
    const box = (ev.currentTarget as SVGRectElement).getBoundingClientRect();
    const x = ev.clientX - box.left, lane = Math.floor((ev.clientY - box.top) / LANE_H);
    const l = laneTicks.get(pools[lane]);
    const i = l ? nearestIndex(l.xs, x) : -1;
    if (!l || i < 0 || Math.abs(l.xs[i] - x) > 8) return setHover(null);
    setHover({ t: l.ts[i], x: labelW + l.xs[i], y: lane * LANE_H + 16 });
  };

  return (
    <div ref={ref} className="relative w-full">
      <svg width={width} height={h} role="img" className="block text-muted-foreground">
        <desc>One lane per pool over the episode&apos;s minutes; each template is a tick coloured by the parent it built on, with lines where the blocks at height − 1 and height arrived.</desc>
        <g transform={`translate(${labelW},16)`}>
          {ticks.map(t => (
            <g key={t.x}>
              <line x1={t.x} x2={t.x} y1={0} y2={lanesH} stroke="currentColor" strokeOpacity={0.12} />
              <text x={t.x} y={lanesH + 14} fontSize={10} textAnchor="middle" fill="currentColor">{t.label}</text>
            </g>
          ))}
          {pools.map((_, i) => <line key={i} x1={0} x2={plotW} y1={(i + 1) * LANE_H} y2={(i + 1) * LANE_H} stroke="currentColor" strokeOpacity={0.08} />)}
          {paths.map(p => <path key={`${p.pool}-${p.label}`} d={p.d} className={LABEL_STROKE[p.label as ParentLabel]} strokeWidth={1.5} fill="none" />)}
          {blocks.map(b => {
            const x = timeX(b.arrival_ms, start, end, plotW);
            const isPrev = b.height === episode.height - 1;
            return (
              <g key={b.hash}>
                <line x1={x} x2={x} y1={-4} y2={lanesH} strokeWidth={1.5}
                  className={b.best ? "stroke-amber-600" : "stroke-[#1550a4] dark:stroke-blue-500"} strokeDasharray={isPrev ? undefined : "4 3"} />
                <text x={x + 3} y={-6} fontSize={10} className="fill-foreground">
                  {isPrev ? "h − 1" : "h"}{b.best ? "" : " (stale)"}
                </text>
              </g>
            );
          })}
          <rect x={0} y={0} width={plotW} height={lanesH} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </g>
        {pools.map((p, i) => (
          <text key={p} x={labelW - 6} y={16 + i * LANE_H + LANE_H / 2 + 4} fontSize={11} textAnchor="end" className="fill-foreground">
            {p.length > (labelW < 100 ? 11 : 20) ? `${p.slice(0, labelW < 100 ? 10 : 19)}…` : p}
          </text>
        ))}
      </svg>
      {hover && (
        <div className="pointer-events-none absolute z-10 rounded-md border border-border bg-background px-2 py-1 text-xs shadow"
          style={{ left: Math.max(0, Math.min(hover.x, width - 230)), top: hover.y + LANE_H, width: 230 }}>
          <div className="font-mono">{fmtUtc(hover.t.received_at)} UTC</div>
          <div>{hover.t.pool_name} {hover.t.connections.join("/")} · height {fmtInt(hover.t.height)}</div>
          <div>built on {LABEL_TEXT[hover.t.parent]}</div>
        </div>
      )}
    </div>
  );
}

function TemplateRow({ t }: { t: Template }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="border-b border-border hover:bg-muted/50 cursor-pointer" onClick={() => setOpen(o => !o)}>
        <td className="p-2 text-xs"><Time ms={t.received_at} /></td>
        <td className="p-2 text-xs whitespace-nowrap">{t.pool_name} <span className="text-muted-foreground">{t.connections.join("/")}</span></td>
        <td className="p-2 font-mono text-xs text-right">{fmtInt(t.height)}</td>
        <td className="p-2 text-xs whitespace-nowrap">
          <span className={`mr-1 inline-block h-2 w-2 rounded-full ${LABEL_BG[t.parent]}`} aria-hidden />{t.parent}
        </td>
        <td className="p-2 font-mono text-xs" title={t.prev_hash}>{t.prev_hash.slice(0, 12)}…</td>
        <td className="p-2 font-mono text-xs max-w-[16rem] truncate" title={t.coinbase_tags}>{t.coinbase_tags || "—"}</td>
        <td className="p-2 text-xs text-right">{t.outputs.length}</td>
        <td className="p-2 font-mono text-xs">{t.nbits}</td>
        <td className="p-2 text-xs">{t.auxpow ? "yes" : ""}</td>
      </tr>
      {open && (
        <tr className="border-b border-border bg-muted/30">
          <td colSpan={9} className="p-3 text-xs">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 font-mono break-all">
              <dt className="text-muted-foreground">prev hash</dt><dd>{t.prev_hash}</dd>
              <dt className="text-muted-foreground">version / nTime</dt><dd>{t.version} / {parseInt(t.ntime, 16)}</dd>
              <dt className="text-muted-foreground">scriptSig height</dt><dd>{t.scriptsig_height ?? "—"}</dd>
              <dt className="text-muted-foreground">AuxPoW root</dt>
              <dd>{t.auxpow_root ? `${t.auxpow_root}${t.auxpow_merkle_size != null ? ` (merkle size ${t.auxpow_merkle_size})` : ""}` : t.auxpow ? "magic outside the scriptSig" : "—"}</dd>
              <dt className="text-muted-foreground">merkle branches</dt><dd>{t.merkle_branches}</dd>
              <dt className="text-muted-foreground">clean jobs</dt><dd>{String(t.clean_jobs)}</dd>
              <dt className="text-muted-foreground">extranonce</dt><dd>{t.extranonce1} + {t.extranonce2_length} bytes</dd>
              <dt className="text-muted-foreground">connections</dt><dd>{t.connections.join(", ")} ({t.copies} cop{t.copies === 1 ? "y" : "ies"})</dd>
              {!t.coinbase_ok && (<><dt className="text-muted-foreground">coinbase</dt><dd>not fully parsed{t.coinbase_error ? `: ${t.coinbase_error}` : ""}</dd></>)}
              <dt className="text-muted-foreground">outputs</dt>
              <dd>
                {t.outputs.length === 0 ? "—" : (
                  <ul>
                    {t.outputs.map((o, i) => (
                      <li key={i}>{(o.value / 1e8).toFixed(8)} → {o.address ?? (o.protocol ? `OP_RETURN (${o.protocol})` : o.script_hex.slice(0, 80))}</li>
                    ))}
                  </ul>
                )}
                <span className="text-muted-foreground font-sans">Total {(t.output_total / 1e8).toFixed(8)}. Addresses use Bitcoin&apos;s encoding.</span>
              </dd>
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

const LIST_PAGE = 200;

function DrillIn({ episode }: { episode: Episode }) {
  const [drill, setDrill] = useState<{ parent: string; data: DrillResponse } | null>(null);
  const [onlyThis, setOnlyThis] = useState(false);
  const [shown, setShown] = useState(LIST_PAGE);
  useEffect(() => {
    const ctl = new AbortController();
    fetch(`/api/unknown-parents?parent=${episode.parent}`, { signal: ctl.signal })
      .then(r => r.json())
      .then((d: DrillResponse) => setDrill({ parent: episode.parent, data: d }))
      .catch(e => { if (e?.name !== "AbortError") setDrill({ parent: episode.parent, data: { error: String(e) } }); });
    return () => ctl.abort();
  }, [episode.parent]);
  const data = drill?.parent === episode.parent ? drill.data : null;
  const list = useMemo(() => (data?.templates ?? []).filter(t => !onlyThis || t.parent === "this"), [data, onlyThis]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of data?.templates ?? []) c[t.parent] = (c[t.parent] ?? 0) + 1;
    return c;
  }, [data]);

  return (
    <section className="mt-6" aria-label="Episode details">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold">Episode at height {fmtInt(episode.height)}</h2>
        <KindChip kind={episode.kind} />
        <span className="text-xs text-muted-foreground">
          parent <span className="font-mono break-all">{episode.parent}</span>
        </span>
      </div>
      <p className="mb-3 text-xs text-muted-foreground max-w-4xl">
        Every template from this episode&apos;s pools at heights {fmtInt(episode.height - 1)} to {fmtInt(episode.height + 1)},
        from 5 minutes before its first template to 5 minutes after its last, coloured by the parent it built on. Vertical
        lines: when the blocks we know at height − 1 (solid) and at its height (dashed) reached us.
      </p>
      {!data && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data?.error && <p className="text-sm text-red-500">{data.error}</p>}
      {data && !data.error && (
        <>
          <div className="mb-2 flex flex-wrap gap-3 text-xs">
            {LABELS.map(l => (
              <span key={l} className="inline-flex items-center gap-1">
                <span className={`inline-block h-3 w-1 ${LABEL_BG[l]}`} aria-hidden />
                {LABEL_TEXT[l]} <span className="text-muted-foreground">{fmtInt(counts[l] ?? 0)}</span>
              </span>
            ))}
          </div>
          <Swimlanes episode={episode} drill={data} />
          <ul className="mt-1 text-xs text-muted-foreground">
            {(data.blocks ?? []).map(b => (
              <li key={b.hash}>
                Block at {b.height === episode.height - 1 ? "height − 1" : "its height"} ({fmtInt(b.height)}, {b.best ? "best chain" : "stale"}):{" "}
                <span className="font-mono">{b.hash.slice(0, 16)}…</span> reached us <Time ms={b.arrival_ms} />
                {(b.arrival_ms < data.from_ms! || b.arrival_ms > data.to_ms!) ? " (outside this range)" : ""}
              </li>
            ))}
            {(data.blocks ?? []).every(b => b.height !== episode.height) && <li>No block stored at its height ({fmtInt(episode.height)}).</li>}
          </ul>
          {data.truncated && <p className="mt-1 text-xs text-amber-700 dark:text-amber-500">Showing the first {fmtInt(data.templates!.length)} templates of the range.</p>}
          <div className="mt-4 mb-2 flex items-center gap-3">
            <h3 className="text-sm font-semibold">Templates</h3>
            <label className="text-xs inline-flex items-center gap-1 cursor-pointer">
              <input type="checkbox" checked={onlyThis} onChange={e => { setOnlyThis(e.target.checked); setShown(LIST_PAGE); }} />
              only on this parent
            </label>
          </div>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  {["Received (UTC)", "Pool", "Height", "Parent", "Prev hash", "Coinbase text", "Outputs", "nBits", "AuxPoW"].map(h => (
                    <th key={h} className={`p-2 text-xs font-medium text-muted-foreground whitespace-nowrap ${h === "Height" || h === "Outputs" ? "text-right" : "text-left"}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.slice(0, shown).map(t => <TemplateRow key={t.id} t={t} />)}
                {list.length === 0 && <tr><td colSpan={9} className="p-4 text-center text-muted-foreground text-xs">No templates.</td></tr>}
              </tbody>
            </table>
          </div>
          {list.length > shown && (
            <button className="mt-2 px-3 py-1 text-xs rounded-md border border-border hover:bg-muted" onClick={() => setShown(s => s + LIST_PAGE)}>
              Show {fmtInt(Math.min(LIST_PAGE, list.length - shown))} more of {fmtInt(list.length - shown)}
            </button>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

export default function UnknownParents() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [kind, setKind] = useState<Kind | "all">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const detailsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/unknown-parents")
      .then(r => r.json())
      .then((d: SummaryResponse) => {
        setSummary(d);
        // a shared link's episode (?parent=…)
        const p = new URLSearchParams(window.location.search).get("parent");
        if (p && /^[0-9a-f]{64}$/i.test(p)) setSelected(p.toLowerCase());
      })
      .catch(e => setSummary({ enabled: true, supported: true, error: String(e) }));
  }, []);

  const select = useCallback((parent: string) => {
    setSelected(parent);
    const url = new URL(window.location.href);
    url.searchParams.set("parent", parent);
    window.history.replaceState(null, "", url);
    requestAnimationFrame(() => detailsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);

  const all = useMemo(() => summary?.episodes ?? [], [summary]);
  const episodes = useMemo(() => (kind === "all" ? all : all.filter(e => e.kind === kind)), [all, kind]);
  const counts = useMemo(() => {
    const c: Partial<Record<Kind, number>> = {};
    for (const e of all) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [all]);
  const selectedEpisode = all.find(e => e.parent === selected) ?? null;

  let body: React.ReactNode;
  if (!summary) body = <p className="text-sm text-muted-foreground">Loading…</p>;
  else if (summary.error) body = <p className="text-sm text-red-500">{summary.error}</p>;
  else if (!summary.enabled) body = <p className="text-sm text-muted-foreground">Historical data is disabled on this deployment.</p>;
  else body = (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Filter by kind">
        {(["all", ...KINDS] as const).filter(k => k === "all" || counts[k]).map(k => (
          <button key={k} onClick={() => setKind(k)} aria-pressed={kind === k}
            className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs ${kind === k ? "border-foreground" : "border-border hover:bg-muted"}`}>
            {k !== "all" && <span className={`inline-block h-2 w-2 rounded-full ${KIND_BG[k]}`} aria-hidden />}
            {k === "all" ? "All" : KIND_LABEL[k]} <span className="text-muted-foreground">{k === "all" ? all.length : counts[k]}</span>
          </button>
        ))}
        <span className="text-xs text-muted-foreground">
          {summary.generated_at ? `computed ${fmtUtc(summary.generated_at)} UTC` : ""}
        </span>
      </div>
      {all.length > 0 && summary.window_start && summary.generated_at && (
        <div className="mb-4 rounded-lg border border-border p-2">
          <EpisodeTimeline episodes={episodes} start={summary.window_start} end={summary.generated_at}
            selected={selected} onSelect={select} />
        </div>
      )}
      <EpisodeTable episodes={episodes} selected={selected} onSelect={select} />
      <div ref={detailsRef}>
        {selectedEpisode && <DrillIn key={selectedEpisode.parent} episode={selectedEpisode} />}
        {selected && summary.episodes && !selectedEpisode && (
          <p className="mt-4 text-sm text-muted-foreground">That parent is no episode of the last {summary.days} days.</p>
        )}
      </div>
    </>
  );

  return (
    <div className="p-4">
      <h1 className="text-lg font-semibold mb-1">Unknown parents</h1>
      <div className="text-xs text-muted-foreground mb-4 max-w-4xl space-y-2">
        <p>
          Every template names the block it builds on (its previous block hash). An <em>unknown parent</em> is one that
          matches no block we have stored, neither on our best chain nor recorded as stale. Over the last 90 days, the
          templates built on each such parent form an episode: the pools and connections (a, b) that built on it, for how
          long, and how many templates. Exact copies of a template on a pool&apos;s several connections count once.
        </p>
        <p>What an unknown parent is gets <strong>inferred</strong> from stored facts, never stored, so every row shows the facts it rests on:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>Unrecorded Bitcoin block</strong>: the parent hash meets proof of work at Bitcoin&apos;s target for the height below
            (the bits of our block at height − 1), with Bitcoin&apos;s difficulty in the templates, usually within one block of our tip
            when it was first seen. A block that lost a race before our node recorded it: many pools for a few minutes, or one
            pool&apos;s own block.</li>
          <li><strong>Another chain</strong>: the templates&apos; difficulty (nbits) isn&apos;t Bitcoin&apos;s at that height, or the height is far from
            our tip with no Bitcoin block there to compare with. Some pools mine other chains on the same connections.</li>
          <li><strong>Invalid parent</strong>: Bitcoin&apos;s height and difficulty, but the hash does not meet the target: not a valid block at all.</li>
        </ul>
        <p>Times are UTC; hover one for your local time. Click an episode in the timeline or the table for its templates.</p>
      </div>
      {body}
    </div>
  );
}
