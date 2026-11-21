"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import { Info } from "lucide-react";
import { useElementWidth } from "@/visuals/framework/useElementWidth";
import { laneSegments, layoutTimeline, placeEpisodes, timeX } from "./unknown-parents/layout";
import { pagePath } from "@/lib/forksPath";

/**
 * Forks (/api/forks): templates built on a block other than our best one, as episodes (one per parent), in
 * Bitcoin time: over the last 6 or 26 difficulty epochs or all history, on an axis of block heights (dates only on
 * hover; the drill-in's sub-block timing stays in clock time). The server aggregates, reads the facts, infers the kind and decodes;
 * this component draws the episodes (timeline, table) and one episode's pools as swimlanes. A parent is a recorded stale
 * block, or no block we know (its kind inferred); an invalid-coinbase finding at the height is a badge. How the kinds
 * are inferred is in docs/methodology.md (linked from the header), not on the page.
 */

type Kind = "stale" | "bitcoin_block" | "other_chain" | "invalid_parent" | "invalid_coinbase" | "undetermined";
type ParentLabel = "best" | "stale" | "this" | "other";
type Range = "6e" | "26e" | "all";

interface Episode {
  parent: string;
  height: number;
  heights: number[];
  pools: { pool: string; connections: string[]; templates: number }[];
  first_ms: number;
  last_ms: number;
  duration_ms: number;
  templates: number;
  auxpow_templates: number | null;
  auxpow_share: number | null;
  facts: {
    tip_at_first: number | null;
    tip_at_last: number | null;
    tip_offset: number | null;
    nbits: string[];
    bitcoin_bits: string | null;
    bitcoin_bits_at: string | null;
    bitcoin_difficulty: boolean | null;
    pow_ok: boolean;
    pow_bits: string;
    in_stale_blocks: boolean;
    stale_block: { height: number; header_source: string | null; miner: string | null } | null;
  };
  kind: Kind;
  invalid_coinbase: InvalidCoinbase | null;
  providers?: number | null;       // template providers among its pools in that epoch (null: not counted there)
  provider_groups?: string[][];    // its pools per provider; a pool in none has an unknown provider
}

interface InvalidCoinbase {
  height: number;
  pools: { pool: string; templates: number; total_sats: number; subsidy_sats: number | null }[];
}

interface SummaryResponse {
  enabled: boolean;
  supported: boolean;
  range?: Range;
  blocks?: number | null;
  tip_height?: number | null;
  from_height?: number | null;
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
  clipped?: boolean;
  blocks?: { hash: string; height: number; arrival_ms: number; best: boolean; miner?: string | null }[];
  error?: string;
}

const METHODOLOGY = "https://github.com/bboerst/stratum-work/blob/main/docs/methodology.md#forks";

/**
 * The filter chips. "Invalid" is all invalid work, work that could never make a valid block: an invalid parent, or an
 * invalid coinbase (an episode of its own, or a badge on the race it happened in).
 */
const CHIPS: Kind[] = ["stale", "bitcoin_block", "other_chain", "invalid_parent", "undetermined"];
const CHIP_LABEL: Partial<Record<Kind, string>> = { invalid_parent: "Invalid" };
function matchesKind(e: Episode, k: Kind): boolean {
  if (k === "invalid_parent") return e.kind === "invalid_parent" || e.kind === "invalid_coinbase" || e.invalid_coinbase !== null;
  return e.kind === k;
}

const KINDS: Kind[] = ["stale", "bitcoin_block", "other_chain", "invalid_parent", "invalid_coinbase", "undetermined"];
const RANGES: Range[] = ["6e", "26e", "all"];
const DEFAULT_RANGE: Range = "6e";
const LEGACY_RANGES: Record<string, Range> = { "90d": "6e", "1y": "26e" };   // earlier links' wall-clock values
const RANGE_LABEL: Record<Range, string> = { "6e": "12,096 blocks", "26e": "52,416 blocks", all: "All" };
const RANGE_TEXT: Record<Range, string> = { "6e": "last 12,096 blocks", "26e": "last 52,416 blocks", all: "all history" };
const KIND_LABEL: Record<Kind, string> = {
  stale: "Race",
  bitcoin_block: "Race · unrecorded",
  other_chain: "Other chain",
  invalid_parent: "Invalid parent",
  invalid_coinbase: "Invalid coinbase",
  undetermined: "Undetermined",
};
// Categorical colours (light / dark): blue = a stale block (the fork view's stale blue; lighter when we never recorded
// it: the same family), violet = another chain, rose = invalid (an outline for an invalid coinbase on our own chain)
const KIND_FILL: Record<Kind, string> = {
  stale: "fill-[#1550a4] dark:fill-blue-500",
  bitcoin_block: "fill-sky-400",
  other_chain: "fill-violet-600 dark:fill-violet-500",
  invalid_parent: "fill-rose-600 dark:fill-rose-500",
  invalid_coinbase: "fill-transparent stroke-rose-500",
  undetermined: "fill-gray-500",
};
const KIND_BG: Record<Kind, string> = {
  stale: "bg-[#1550a4] dark:bg-blue-500",
  bitcoin_block: "bg-sky-400",
  other_chain: "bg-violet-600 dark:bg-violet-500",
  invalid_parent: "bg-rose-600 dark:bg-rose-500",
  invalid_coinbase: "border-2 border-rose-500",
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
  if (e.kind === "invalid_coinbase") return `${KIND_LABEL[e.kind]} · our best block's parent at height ${fmtInt(e.height - 1)}`;
  return [
    e.kind === "stale" ? `${KIND_LABEL[e.kind]} (recorded${f.stale_block?.miner ? `, mined by ${f.stale_block.miner}` : ""})` : `${KIND_LABEL[e.kind]} (inferred)`,
    `proof of work ${f.pow_ok ? "✓" : "✗"} (bits ${f.pow_bits})`,
    `Bitcoin difficulty ${f.bitcoin_difficulty === null ? "?" : f.bitcoin_difficulty ? "✓" : "✗"}`,
    `parent at height ${fmtInt(e.height - 1)} · our tip ${f.tip_at_first === null ? "none yet" : fmtInt(f.tip_at_first)}`,
  ].join(" · ");
}

const fmtBtc = (sats: number) => (sats / 1e8).toFixed(8);

const plural = (n: number, word: string) => `${fmtInt(n)} ${word}${n === 1 ? "" : "s"}`;

/**
 * The episode's template providers (docs/methodology.md "Template providers"): how many independent ones its pools
 * are on, in the epoch it began in. Null when that epoch isn't counted; `unknown` = pools whose provider isn't known there.
 */
function providerInfo(e: Episode): { n: number; groups: string[][]; unknown: string[]; text: string; title: string } | null {
  if (e.providers === null || e.providers === undefined) return null;
  const groups = e.provider_groups ?? [];
  const known = new Set(groups.flat());
  const unknown = e.pools.map(p => p.pool).filter(p => !known.has(p));
  const n = e.providers;
  const text = n === 0 ? "provider unknown" : `${plural(n, "provider")}${unknown.length ? ` · ${fmtInt(unknown.length)} unknown` : ""}`;
  const title = [`${plural(n, "template provider")} among ${plural(e.pools.length, "pool")} (identical transaction sets in that difficulty epoch; not ownership)`,
    ...groups.map(g => g.join(", ")), ...(unknown.length ? [`provider unknown: ${unknown.join(", ")}`] : [])].join("\n");
  return { n, groups, unknown, text, title };
}

/** The invalid-coinbase finding at the episode's height: a small rose badge, the pools and amounts on hover. */
function InvalidCoinbaseBadge({ ic }: { ic: InvalidCoinbase }) {
  const title = ic.pools.map(p => `${p.pool}: ${p.templates} template${p.templates > 1 ? "s" : ""} · paid ${fmtBtc(p.total_sats)} BTC${p.subsidy_sats === null ? "" : ` vs subsidy ${fmtBtc(p.subsidy_sats)}`}`).join("\n");
  return (
    <span title={`Coinbase above the subsidy with no transactions, at height ${fmtInt(ic.height)}\n${title}`}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-rose-600/50 px-2 py-0.5 text-[11px] text-rose-600 dark:text-rose-400">
      ✗ invalid coinbase · {ic.pools.length} pool{ic.pools.length > 1 ? "s" : ""}
    </span>
  );
}

function KindChip({ kind, title, alsoInvalid = false }: { kind: Kind; title?: string; alsoInvalid?: boolean }) {
  return (
    <span title={title ?? (kind === "stale" ? "Recorded" : "Inferred")} className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
      {alsoInvalid
        // two findings in one episode (e.g. a race with an invalid coinbase): the dot is half each colour
        ? <span className="inline-flex h-2.5 w-2.5 flex-col overflow-hidden rounded-full" aria-hidden>
            <span className={`h-1/2 w-full ${KIND_BG[kind]}`} /><span className="h-1/2 w-full bg-rose-500" />
          </span>
        : <span className={`inline-block h-2.5 w-2.5 rounded-full ${KIND_BG[kind]}`} aria-hidden />}
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

/** The table's providers count: the number, "+N?" for pools whose provider is unknown; "–" before that epoch was counted. */
function ProvidersCell({ e }: { e: Episode }) {
  const p = providerInfo(e);
  return (
    <td className="px-3 py-2.5 font-mono text-right text-xs whitespace-nowrap" title={p?.title ?? "not counted for this height yet"}>
      {p ? <>{p.n}{p.unknown.length > 0 && <span className="text-foreground/40"> +{p.unknown.length}?</span>}</> : <span className="text-foreground/30">–</span>}
    </td>
  );
}

/** The details' pools grouped by template provider: a box per provider, a dashed one for the unknown ones. */
function ProviderGroups({ e }: { e: Episode }) {
  const p = providerInfo(e);
  if (!p || e.pools.length < 2) return null;
  const box = "inline-flex flex-wrap items-center gap-1 rounded-md border px-1.5 py-1";
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px]" aria-label="Pools by template provider">
      {p.groups.map(g => (
        <span key={g.join(",")} className={`${box} border-foreground/25`} title={`one template provider: ${g.join(", ")}`}>
          {g.map(pool => <span key={pool} className="rounded bg-foreground/10 px-1.5 py-0.5 whitespace-nowrap">{pool}</span>)}
        </span>
      ))}
      {p.unknown.length > 0 && (
        <span className={`${box} border-dashed border-foreground/25`} title="provider unknown in that difficulty epoch (too few transaction sets counted)">
          <span className="px-0.5 text-foreground/50">?</span>
          {p.unknown.map(pool => <span key={pool} className="rounded bg-foreground/5 px-1.5 py-0.5 whitespace-nowrap text-foreground/60">{pool}</span>)}
        </span>
      )}
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

/** The timeline in Bitcoin time: x = block height, from `start` to `end` (our tip). */
function EpisodeTimeline({ episodes, start, end, selected, onSelect }: {
  episodes: Episode[]; start: number; end: number; selected: string | null; onSelect: (p: string) => void;
}) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const labelW = width < 520 ? 76 : 120;
  const plotW = Math.max(50, width - labelW - 8);
  const { placed, unplaced } = useMemo(() => placeEpisodes(episodes, start, end), [episodes, start, end]);
  const layout = useMemo(() => layoutTimeline(placed, start, end, plotW, 5), [placed, start, end, plotW]);
  const byParent = useMemo(() => new Map(episodes.map(e => [e.parent, e])), [episodes]);
  const [hover, setHover] = useState<{ parent: string; x: number; y: number } | null>(null);
  const ticks = useMemo(() => {
    const s = d3.scaleLinear().domain([start, end]).range([0, plotW]);
    return s.ticks(Math.max(3, Math.min(7, Math.floor(plotW / 110)))).map(v => ({ x: s(v), label: fmtInt(v) }));
  }, [start, end, plotW]);
  const h = layout.pools.length * ROW_H + AXIS_H;
  const hovered = hover ? byParent.get(hover.parent) : null;
  // Hovering an episode brings it forward: its marks on every pool's row are outlined over a column, the rest stay
  // almost as they were (a light fade), and its pools' row labels light up, so episodes close in height can be told
  // apart. The selected episode keeps its column and outline.
  const focus = hover?.parent ?? null;
  const focusPools = useMemo(() => new Set(focus ? (byParent.get(focus)?.pools ?? []).map(p => p.pool) : []), [focus, byParent]);
  const spanFor = focus ?? selected;
  const focusSpan = useMemo(() => {
    if (!spanFor) return null;
    const ms = layout.marks.filter(m => m.parent === spanFor);
    if (ms.length === 0) return null;
    const x0 = Math.min(...ms.map(m => m.x)), x1 = Math.max(...ms.map(m => m.x + m.w));
    return { x: x0 - 3, w: x1 - x0 + 6 };
  }, [spanFor, layout]);

  return (
    <div ref={ref} className="relative w-full">
      <svg width={width} height={h} role="img" className="block text-foreground/60">
        <desc>One row per pool over the last {fmtInt(Math.max(0, end - start))} blocks; a mark per episode, over the heights being mined while it lasted, coloured by its inferred kind.</desc>
        <g transform={`translate(${labelW},0)`}>
          {ticks.map(t => (
            <g key={t.x}>
              <line x1={t.x} x2={t.x} y1={0} y2={h - AXIS_H} stroke="currentColor" strokeOpacity={0.12} />
              {/* a label near the right edge ends at its line, so it stays inside the plot */}
              <text x={t.x > plotW - 50 ? t.x - 3 : t.x + 3} y={h - 5} fontSize={11} fill="currentColor"
                textAnchor={t.x > plotW - 50 ? "end" : "start"}>{t.label}</text>
            </g>
          ))}
          {focusSpan && <rect x={focusSpan.x} y={0} width={focusSpan.w} height={h - AXIS_H} rx={3}
            className="fill-foreground/10" pointerEvents="none" />}
          {/* the other marks fade lightly, in one group with one opacity, so overlapping marks don't add up to solid */}
          {[false, true].map(isFocus => (
            <g key={String(isFocus)} opacity={focus && !isFocus ? 0.7 : 1}>
          {layout.marks.map((m, i) => ((focus === m.parent) !== isFocus ? null :
            <g key={i} className="cursor-pointer" data-episode={m.parent}
              onMouseEnter={() => setHover({ parent: m.parent, x: labelW + m.x, y: (m.row + 1) * ROW_H + 4 })}
              onMouseLeave={() => setHover(null)}
              onClick={() => onSelect(m.parent)}>
              <rect x={m.x - 4} y={m.row * ROW_H} width={m.w + 8} height={ROW_H} fill="transparent" />
              <rect x={m.x} y={m.row * ROW_H + (ROW_H - MARK_H) / 2} width={m.w} height={MARK_H} rx={2}
                className={`${KIND_FILL[m.kind as Kind] ?? KIND_FILL.undetermined} ${focus === m.parent || selected === m.parent ? "stroke-foreground" : ""}`}
                strokeWidth={focus === m.parent || selected === m.parent ? 1.5 : m.kind === "invalid_coinbase" ? 1.5 : 0}
                />
              {/* two findings in one episode (a race with an invalid coinbase): the mark's lower half is rose on the
                  rows of the pools whose coinbase was invalid */}
              {m.kind !== "invalid_coinbase" && byParent.get(m.parent)?.invalid_coinbase?.pools.some(p => p.pool === layout.pools[m.row]) && (
                <rect x={m.x} y={m.row * ROW_H + ROW_H / 2} width={m.w} height={MARK_H / 2} className="fill-rose-500" pointerEvents="none" />
              )}
            </g>
          ))}
            </g>
          ))}
        </g>
        {layout.pools.map((p, i) => (
          <text key={p} x={labelW - 8} y={i * ROW_H + ROW_H / 2 + 4} fontSize={12} textAnchor="end"
            fontWeight={focusPools.has(p) ? 700 : 400}
            className={focus && focusPools.has(p) ? "fill-foreground" : "fill-foreground/60"}>
            <title>{p}</title>{shortName(p, labelW < 100)}
          </text>
        ))}
      </svg>
      {hovered && hover && (
        <Tooltip x={hover.x} y={hover.y} width={width}>
          <KindChip kind={hovered.kind} />
          <div className="mt-1 font-mono">{fmtInt(hovered.height)}</div>
          <div className="text-foreground/60">{plural(hovered.pools.length, "pool")}{providerInfo(hovered) ? ` · ${providerInfo(hovered)!.text}` : ""} · {fmtDuration(hovered.duration_ms)}</div>
          <div className="mt-0.5 text-foreground/80">{hovered.pools.map(p => p.pool).join(", ")}</div>
          <div className="text-foreground/40">{fmtUtc(hovered.first_ms)} UTC</div>
        </Tooltip>
      )}
      {unplaced > 0 && <p className="mt-1 text-right text-[11px] text-foreground/60">{fmtInt(unplaced)} not placed</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Table

type SortKey = "bitcoin" | "height" | "pools" | "providers" | "duration" | "kind";

function sortValue(e: Episode, k: SortKey): number {
  switch (k) {
    case "bitcoin": return (e.facts.tip_at_first ?? -1) * 1e13 + e.first_ms;   // Bitcoin time: our tip when it began
    case "height": return e.height;
    case "pools": return e.pools.length;
    case "providers": return e.providers ?? -1;   // not counted: below 0
    case "duration": return e.duration_ms;
    case "kind": return KINDS.indexOf(e.kind);
  }
}

function EpisodeTable({ episodes, selected, onSelect }: { episodes: Episode[]; selected: string | null; onSelect: (p: string) => void }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "bitcoin", desc: true });
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
                <span className="font-mono text-sm">{fmtInt(e.height)} <span className="text-foreground/60 text-xs">· {fmtDuration(e.duration_ms)}</span></span>
                <KindChip kind={e.kind} title={factsTitle(e)} alsoInvalid={!!e.invalid_coinbase && e.kind !== "invalid_coinbase"} />
              </div>
              <div className="text-foreground/40" title={fmtLocal(e.first_ms)}>{fmtUtc(e.first_ms)}</div>
              {e.invalid_coinbase && e.kind !== "invalid_coinbase" && <InvalidCoinbaseBadge ic={e.invalid_coinbase} />}
              <PoolChips e={e} max={4} />
              {providerInfo(e) && <div className="text-foreground/60" title={providerInfo(e)!.title}>{providerInfo(e)!.text}</div>}
            </button>
          </li>
        ))}
      </ul>
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              {head("Height", "height")}
              {head("Pools", "pools")}
              {head("Providers", "providers", true)}
              {head("Duration", "duration", true)}
              {head("Kind", "kind")}
              {head("UTC", "bitcoin", true)}
            </tr>
          </thead>
          <tbody>
            {rows.map(e => (
              <tr key={e.parent} onClick={() => onSelect(e.parent)}
                className={`border-b border-border/60 cursor-pointer hover:bg-foreground/5 ${e.parent === selected ? "bg-foreground/10" : ""}`}>
                <td className="px-3 py-2.5 font-mono">{fmtInt(e.height)}</td>
                <td className="px-3 py-2.5"><PoolChips e={e} /></td>
                <ProvidersCell e={e} />
                <td className="px-3 py-2.5 font-mono text-right text-xs">{fmtDuration(e.duration_ms)}</td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <KindChip kind={e.kind} title={factsTitle(e)} alsoInvalid={!!e.invalid_coinbase && e.kind !== "invalid_coinbase"} />
                    {e.invalid_coinbase && <InvalidCoinbaseBadge ic={e.invalid_coinbase} />}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-xs text-foreground/40 text-right whitespace-nowrap" title={fmtLocal(e.first_ms)}>{fmtUtc(e.first_ms)}</td>
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
  // Invalid coinbase: an empty template (no merkle branches) paying more than the block subsidy, as the backend's
  // analysis flags it. Runs of such templates per pool are drawn over the lanes; templates whose coinbase didn't parse
  // can't be judged here (the episode's badge, from the backend, names their pools).
  const invalid = useMemo(() => {
    const subsidy = (h: number) => Math.floor(5_000_000_000 / 2 ** Math.floor(h / 210_000));
    const byPool = new Map<string, Template[]>();
    for (const t of drill.templates ?? []) {
      const l = byPool.get(t.pool_name) ?? []; l.push(t); byPool.set(t.pool_name, l);
    }
    const runs: { pool: string; x: number; w: number; n: number; total: number; subsidy: number }[] = [];
    for (const [pool, ts] of byPool) {
      ts.sort((a, b) => a.received_at - b.received_at);
      let cur: { from: number; to: number; n: number; total: number; subsidy: number } | null = null;
      ts.forEach((t, i) => {
        const bad = t.merkle_branches === 0 && t.coinbase_ok && t.output_total > subsidy(t.height);
        const next = ts[i + 1]?.received_at ?? t.received_at + 1000;
        if (bad) {
          if (cur) { cur.to = next; cur.n++; } else cur = { from: t.received_at, to: next, n: 1, total: t.output_total, subsidy: subsidy(t.height) };
        } else if (cur) {
          const x0 = timeX(cur.from, start, end, plotW), x1 = timeX(cur.to, start, end, plotW);
          runs.push({ pool, x: x0, w: Math.max(3, x1 - x0), n: cur.n, total: cur.total, subsidy: cur.subsidy }); cur = null;
        }
      });
      if (cur) {
        const c: { from: number; to: number; n: number; total: number; subsidy: number } = cur;
        const x0 = timeX(c.from, start, end, plotW), x1 = timeX(c.to, start, end, plotW);
        runs.push({ pool, x: x0, w: Math.max(3, x1 - x0), n: c.n, total: c.total, subsidy: c.subsidy });
      }
    }
    return runs;
  }, [drill, start, end, plotW]);
  const offenders = useMemo(() => new Set([...(episode.invalid_coinbase?.pools ?? []).map(p => p.pool), ...invalid.map(r => r.pool)]), [episode, invalid]);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const ticks = useMemo(() => {
    const s = d3.scaleUtc().domain([start, end]).range([0, plotW]);
    return s.ticks(Math.max(2, Math.min(6, Math.floor(plotW / 120)))).map(d => ({ x: s(d), label: d3.utcFormat("%H:%M")(d) }));
  }, [start, end, plotW]);
  const lanesH = pools.length * LANE_H;
  const top = 32;   // room for two rows of block labels
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
          {invalid.map((r, i) => {
            const row = lane.get(r.pool);
            if (row === undefined) return null;
            return (
              <rect key={`ic${i}`} x={r.x} y={row * LANE_H + (LANE_H - BAR_H) / 2 - 2} width={r.w} height={BAR_H + 4} rx={2}
                className="fill-rose-500 stroke-rose-300" strokeWidth={1}>
                <title>{`${r.pool}: ${r.n} empty job${r.n > 1 ? "s" : ""} paying ${(r.total / 1e8).toFixed(8)} BTC, over the ${(r.subsidy / 1e8).toFixed(3)} BTC subsidy (invalid coinbase)`}</title>
              </rect>
            );
          })}
          {(() => {
            // Labels of blocks that arrived moments apart would overlap: a label goes up a row when it sits within a
            // label's width of the previous one (two blocks at one height arrive seconds apart in a race).
            const rows = new Map<string, number>();
            let lastX = -Infinity, lastRow = 1;
            for (const b of [...(drill.blocks ?? [])].sort((a, c) => a.arrival_ms - c.arrival_ms)) {
              const x = timeX(b.arrival_ms, start, end, plotW);
              const row = x - lastX < 60 ? 1 - lastRow : 0;
              rows.set(b.hash, row); lastX = x; lastRow = row;
            }
            return (drill.blocks ?? []).map(b => {
            const label = fmtInt(b.height);   // the block's own height (Bitcoin time), not h-relative shorthand
            const before = b.arrival_ms < start, after = b.arrival_ms > end;
            const x = timeX(b.arrival_ms, start, end, plotW);
            const ly = -6 - 13 * (rows.get(b.hash) ?? 0);
            const cls = b.best ? "text-amber-600" : "text-[#1550a4] dark:text-blue-500";
            return (
              <g key={b.hash} className={cls}>
                <title>{`block ${label} arrived · ${b.best ? "best chain" : "stale"} · ${fmtUtcS(b.arrival_ms)} UTC`}</title>
                {!before && !after && <line x1={x} x2={x} y1={ly + 2} y2={lanesH} stroke="currentColor" strokeWidth={1.5} />}
                <text x={before ? 0 : after ? plotW : x} y={ly} fontSize={11} fill="currentColor"
                  textAnchor={after ? "end" : before ? "start" : "middle"}>
                  {before ? `‹ ${label}` : after ? `${label} ›` : label}
                </text>
              </g>
            );
            });
          })()}
        </g>
        {pools.map((p, i) => (
          <text key={p} x={labelW - 8} y={top + i * LANE_H + LANE_H / 2 + 4} fontSize={12} textAnchor="end"
            className={offenders.has(p) ? "fill-rose-500" : "fill-foreground/60"}>
            <title>{offenders.has(p) ? `${p}: invalid coinbase` : p}</title>{offenders.has(p) ? "✗ " : ""}{shortName(p, labelW < 100)}
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

/**
 * Why an episode is here, drawn: our chain (the best blocks at the parent's height and the next, as tiles) and, hanging
 * below it at the height its templates claim, the parent they built on: a recorded stale block (a solid blue tile, a
 * real block like ours, with its miner when known), or no block we know (a dashed outline). Four checks under it carry
 * the kind: at our tip, the parent's proof of work, whether the templates use Bitcoin's difficulty, and whether the
 * parent is a block we know. An other-chain parent sits off our chain, its height beside ours.
 */
function WhyUnknown({ episode, drill }: { episode: Episode; drill: DrillResponse }) {
  const f = episode.facts;
  const ph = episode.height - 1;                      // the parent's claimed height
  const ours = (h: number) => (drill.blocks ?? []).find(b => b.height === h && b.best);
  const prev = ours(ph), next = ours(episode.height);
  const onOurChain = f.tip_at_first !== null && Math.abs(ph - f.tip_at_first) <= 1;
  // Our blocks at the parent's height only when the episode was at our tip; otherwise our tip at the time, with the
  // parent below it (another chain's height can sit close to Bitcoin's: those blocks were mined long before).
  const chain = onOurChain;
  // The blocks strip's tile (components/Blocks.tsx .block-3d): a 104 x 64 chevron, its point toward the newer block,
  // newest on the left; the height in bold monospace over a smaller line.
  const TW = 104, TH = 64, G = 4, X0 = 4, Y0 = 18, Y1 = Y0 + TH + 22;
  const chevron = (x: number, y: number) =>
    [[4, 32], [19, 0], [104, 0], [90, 32], [104, 64], [19, 64]].map(([px, py]) => `${x + px},${y + py}`).join(" ");
  const tile = (x: number, y: number, label: string, sub: string, cls: string, dashed = false, title = "", onColour = false) => (
    <g>
      <title>{title}</title>
      <polygon points={chevron(x, y)} className={cls} strokeWidth={dashed ? 1.5 : 0}
        strokeDasharray={dashed ? "4 3" : undefined} />
      <text x={x + 54} y={y + 30} textAnchor="middle" fontSize={15} fontWeight={700}
        className={`font-mono ${onColour ? "fill-white" : "fill-black dark:fill-[#d7d7d7]"}`}>{label}</text>
      <text x={x + 54} y={y + 46} textAnchor="middle" fontSize={10}
        className={`font-mono ${onColour ? "fill-white/80" : "fill-black/75 dark:fill-[#d7d7d7]/75"}`}>{sub}</text>
    </g>
  );
  const STRIP = "fill-[#eceaea] dark:fill-[#313131]";
  const short = (h: string) => `${h.slice(0, 4)}…${h.slice(-6)}`;
  const xNext = X0, xPrev = X0 + TW + G;   // newest on the left, as in the strip
  const unknownX = xPrev;
  const stale = episode.kind === "stale";
  const sb = f.stale_block;
  const kindStroke = episode.kind === "other_chain" ? "stroke-violet-500" : episode.kind === "invalid_parent" ? "stroke-rose-500"
    : episode.kind === "bitcoin_block" ? "stroke-sky-400" : "stroke-gray-500";
  const miner = sb?.miner ? (sb.miner.length > 14 ? `${sb.miner.slice(0, 13)}…` : sb.miner) : null;
  const pools = episode.pools.map(p => p.pool);
  const checks: { ok: boolean | null; label: string; title: string }[] = [
    { ok: onOurChain, label: "at our tip",
      title: `parent at height ${fmtInt(ph)} · our tip ${f.tip_at_first === null ? "none" : fmtInt(f.tip_at_first)}${onOurChain ? "" : `: ${fmtInt(Math.abs(ph - (f.tip_at_first ?? ph)))} blocks ${ph < (f.tip_at_first ?? ph) ? "below" : "above"} our tip when it arrived`}` },
    { ok: f.pow_ok, label: "proof of work",
      title: f.pow_ok ? `the parent's hash meets the target of bits ${f.pow_bits}` : `the parent's hash misses the target of bits ${f.pow_bits}: not a valid block` },
    { ok: f.bitcoin_difficulty, label: "Bitcoin's difficulty",
      title: f.bitcoin_difficulty === null ? "no Bitcoin block stored to compare with"
        : `templates' nbits ${f.nbits[0] ?? "?"} ${f.bitcoin_difficulty ? "=" : "≠"} Bitcoin's bits ${f.bitcoin_bits ?? "?"} at height ${fmtInt(ph)}` },
    stale
      ? { ok: true, label: "a block we know",
          title: `a stale block we recorded at height ${fmtInt(sb?.height ?? ph)}${sb?.header_source ? ` (header from ${sb.header_source})` : ""}${sb?.miner ? `, mined by ${sb.miner}` : ""}` }
      : { ok: false, label: "a block we know", title: "the parent is in neither our node's chain nor the stale-block records" },
  ];
  const W = xPrev + TW + 330;
  return (
    <div className="mb-5">
      <svg width={W} height={Y1 + TH + 6} role="img" className="block max-w-full" viewBox={`0 0 ${W} ${Y1 + TH + 6}`}>
        <desc>Our chain at the parent&apos;s height and the next, and below it the parent the templates built on.</desc>
        <text x={X0} y={11} fontSize={10} className="fill-foreground/50">our chain</text>
        {chain && prev ? tile(xPrev, Y0, fmtInt(prev.height), prev.miner ?? short(prev.hash), STRIP, false, `best block ${fmtInt(prev.height)}${prev.miner ? ` · mined by ${prev.miner}` : ""} · ${prev.hash}`)
              : tile(chain ? xPrev : xNext, Y0, chain ? fmtInt(ph) : f.tip_at_first !== null ? fmtInt(f.tip_at_first) : "—", "", STRIP)}
        {chain && next ? tile(xNext, Y0, fmtInt(next.height), next.miner ?? short(next.hash), STRIP, false, `best block ${fmtInt(next.height)}${next.miner ? ` · mined by ${next.miner}` : ""} · ${next.hash}`)
              : chain ? tile(xNext, Y0, fmtInt(episode.height), "", STRIP) : null}
        {!chain && <text x={xNext + TW + 12} y={Y0 + TH / 2 + 4} fontSize={11} className="fill-foreground/50">our tip</text>}
        {chain && <line x1={xPrev + 54} x2={xPrev + 54} y1={Y0 + TH} y2={Y1} className="stroke-foreground/30" strokeDasharray="3 3" />}
        {stale
          ? tile(chain ? unknownX : xNext, Y1, fmtInt(sb?.height ?? ph), miner ?? short(episode.parent), "fill-[#1550a4] dark:fill-blue-600", false,
              `stale block ${fmtInt(sb?.height ?? ph)} · ${episode.parent}${sb?.miner ? ` · mined by ${sb.miner}` : ""}`, true)
          : tile(chain ? unknownX : xNext, Y1, fmtInt(ph), short(episode.parent), `fill-transparent ${kindStroke}`, true, `the parent the templates built on: ${episode.parent}`)}
        <text x={(chain ? unknownX : xNext) + TW + 12} y={Y1 + 26} fontSize={11} className="fill-foreground/70">← {pools.length} pool{pools.length > 1 ? "s" : ""} built on it</text>
        <text x={(chain ? unknownX : xNext) + TW + 12} y={Y1 + 42} fontSize={10} className="fill-foreground/50">{pools.slice(0, 4).join(", ")}{pools.length > 4 ? ` +${pools.length - 4}` : ""}</text>
        {episode.invalid_coinbase && (() => {
          const ic = episode.invalid_coinbase.pools.map(p => p.pool);
          return <text x={(chain ? unknownX : xNext) + TW + 12} y={Y1 + 58} fontSize={10} className="fill-rose-500">
            <title>{episode.invalid_coinbase.pools.map(p => `${p.pool}: ${(p.total_sats / 1e8).toFixed(8)} BTC${p.subsidy_sats ? ` vs ${(p.subsidy_sats / 1e8).toFixed(3)} subsidy` : ""}`).join("\n")}</title>
            ✗ invalid coinbase: {ic.slice(0, 3).join(", ")}{ic.length > 3 ? ` +${ic.length - 3}` : ""}
          </text>;
        })()}
      </svg>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        {checks.map(c => (
          <span key={c.label} title={c.title}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 ${c.ok === null ? "border-border text-foreground/60" : c.ok ? "border-emerald-600/50 text-emerald-500" : "border-rose-600/50 text-rose-500"}`}>
            {c.ok === null ? "?" : c.ok ? "✓" : "✗"} {c.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5 px-1 text-foreground/70">→ <KindChip kind={episode.kind} title={factsTitle(episode)} alsoInvalid={!!episode.invalid_coinbase && episode.kind !== "invalid_coinbase"} /></span>
      </div>
    </div>
  );
}

function DrillIn({ episode, range }: { episode: Episode; range: Range }) {
  const [drill, setDrill] = useState<{ parent: string; data: DrillResponse } | null>(null);
  const [showList, setShowList] = useState(false);
  const [shown, setShown] = useState(LIST_PAGE);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const ctl = new AbortController();
    fetch(`/api/forks?parent=${episode.parent}&range=${range}`, { signal: ctl.signal })
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
        <KindChip kind={episode.kind} title={factsTitle(episode)} alsoInvalid={!!episode.invalid_coinbase && episode.kind !== "invalid_coinbase"} />
        <span className="font-mono text-base">{fmtInt(episode.height)}</span>
        <button type="button" className="font-mono text-xs text-foreground/60 hover:text-foreground"
          title={`${episode.parent} · click to copy`}
          onClick={() => navigator.clipboard?.writeText(episode.parent).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }, () => {})}>
          {copied ? "copied" : `${episode.parent.slice(0, 6)}…${episode.parent.slice(-6)}`}
        </button>
        <span className="text-xs text-foreground/60">
          {plural(episode.pools.length, "pool")}
          {providerInfo(episode) && <span title={providerInfo(episode)!.title}> · {providerInfo(episode)!.text}</span>}
        </span>
        <span className="text-xs text-foreground/60">{fmtDuration(episode.duration_ms)}</span>
        {episode.kind !== "invalid_coinbase" && (
          <span className="text-xs text-foreground/60" title={factsTitle(episode)}>
            PoW {episode.facts.pow_ok ? "✓" : "✗"}
          </span>
        )}
        {episode.invalid_coinbase && <InvalidCoinbaseBadge ic={episode.invalid_coinbase} />}
        <span className="ml-auto flex flex-wrap gap-3 text-xs text-foreground/60">
          {LABELS.filter(l => present.has(l)).map(l => (
            <span key={l} className="inline-flex items-center gap-1.5">
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${LABEL_BG[l]}`} aria-hidden />{LABEL_TEXT[l]}
            </span>
          ))}
          {episode.invalid_coinbase && (
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-rose-500" aria-hidden />invalid coinbase
            </span>
          )}
        </span>
      </div>
      <ProviderGroups e={episode} />
      {!data && <p className="py-8 text-center text-xs text-foreground/60">Loading…</p>}
      {data?.error && <p className="text-sm text-red-500">{data.error}</p>}
      {data && !data.error && (
        <>
          {episode.kind !== "invalid_coinbase" && <WhyUnknown episode={episode} drill={data} />}
          <Swimlanes episode={episode} drill={data} />
          {data.clipped && <p className="mt-1 text-xs text-foreground/50">first 30 min of {fmtDuration(episode.duration_ms)}</p>}
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

/**
 * The address for what's shown (shareable): the selected episode's short link (/forks/<height>[/<kind>], no range:
 * lib/forksPath.ts), or /forks with a range other than the default.
 */
function pageUrl(selected: Episode | null, all: Episode[], range: Range): string {
  if (selected) return pagePath(selected, all, range);
  return range === DEFAULT_RANGE ? "/forks" : `/forks?range=${range}`;
}

/** initial: the episode a short link opens (resolved on the server) and the range it was found in. */
export default function Forks({ initial = null }: { initial?: { range: Range; parent: string } | null }) {
  const initialRange = initial?.range ?? null, initialParent = initial?.parent ?? null;
  const [range, setRange] = useState<Range>(initialRange ?? DEFAULT_RANGE);
  // each range's last answer (switching back is instant; a late answer only fills its own range)
  const [loaded, setLoaded] = useState<Partial<Record<Range, SummaryResponse>>>({});
  const [kind, setKind] = useState<Kind | "all">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const detailsRef = useRef<HTMLDivElement>(null);

  const load = useCallback((r: Range) => fetch(`/api/forks?range=${r}`)
    .then(res => res.json())
    .then((d: SummaryResponse) => setLoaded(m => ({ ...m, [r]: d })))
    .catch(e => setLoaded(m => ({ ...m, [r]: { enabled: true, supported: true, error: String(e) } }))), []);

  useEffect(() => {
    // A short link's episode (resolved on the server), else a link's ?range=… and an older link's ?parent=… (the
    // server redirects those to the short link when it can; one it couldn't resolve is looked up here).
    if (initialRange && initialParent) {
      load(initialRange).then(() => setSelected(initialParent));
      return;
    }
    const q = new URLSearchParams(window.location.search);
    const asked = q.get("range") ?? "";
    const legacy = Object.hasOwn(LEGACY_RANGES, asked);
    const r = RANGES.find(x => x === (legacy ? LEGACY_RANGES[asked] : asked)) ?? DEFAULT_RANGE;
    const p = q.get("parent");
    load(r).then(() => {
      setRange(r);
      if (p && /^[0-9a-f]{64}$/i.test(p)) setSelected(p.toLowerCase());
    });
  }, [load, initialRange, initialParent]);
  const summary = loaded[range] ?? null;

  // Clicking the selected episode again deselects it (and closes its details).
  const select = useCallback((parent: string) => {
    const next = selected === parent ? null : parent;
    setSelected(next);
    if (next) requestAnimationFrame(() => detailsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [selected]);
  const chooseRange = (r: Range) => {
    if (r === range) return;
    setRange(r);
    load(r);
  };

  const all = useMemo(() => summary?.episodes ?? [], [summary]);
  const episodes = useMemo(() => (kind === "all" ? all : all.filter(e => matchesKind(e, kind))), [all, kind]);
  const counts = useMemo(() => {
    const c: Partial<Record<Kind, number>> = {};
    for (const e of all) for (const k of CHIPS) if (matchesKind(e, k)) c[k] = (c[k] ?? 0) + 1;
    return c;
  }, [all]);
  const selectedEpisode = all.find(e => e.parent === selected) ?? null;
  // the other episodes at the selected one's height (a race and another chain's parent can share one)
  const sameHeight = useMemo(() => (selectedEpisode ? all.filter(e => e.height === selectedEpisode.height && e !== selectedEpisode) : []),
    [all, selectedEpisode]);

  // Keep the address on what's shown (shareable), once the range's summary is in: history.replaceState, which Next.js
  // keeps in step with its router, so no navigation, no server render, no scroll. A selection the summary doesn't
  // have (an old link to an episode out of range, or the range still loading) leaves the address alone.
  useEffect(() => {
    if (!summary?.episodes || (selected && !selectedEpisode)) return;
    const next = pageUrl(selectedEpisode, all, range);
    if (window.location.pathname + window.location.search !== next) window.history.replaceState(null, "", next);
  }, [summary, selected, selectedEpisode, all, range]);

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
        {(["all", ...CHIPS] as const).filter(k => k === "all" || counts[k]).map(k => (
          <button key={k} onClick={() => setKind(k)} aria-pressed={kind === k}
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors ${kind === k ? "border-foreground/60 bg-foreground/10" : "border-border hover:bg-foreground/5"}`}>
            {k !== "all" && <span className={`inline-block h-2.5 w-2.5 rounded-full ${KIND_BG[k]}`} aria-hidden />}
            {k === "all" ? "All" : CHIP_LABEL[k] ?? KIND_LABEL[k]}
            <span className="font-mono text-foreground/60">{k === "all" ? all.length : counts[k]}</span>
          </button>
        ))}
        {rangePicker}
      </div>
      {all.length > 0 && summary.from_height != null && summary.tip_height != null && (
        <div className="mb-8 rounded-xl border border-border p-4">
          <EpisodeTimeline episodes={episodes} start={summary.from_height} end={summary.tip_height}
            selected={selected} onSelect={select} />
        </div>
      )}
      <div ref={detailsRef} className="scroll-mt-4">
        {sameHeight.length > 0 && (
          <div className="mt-8 -mb-5 flex flex-wrap items-center gap-2 text-xs text-foreground/60" aria-label="Also at this height">
            also at {fmtInt(selectedEpisode!.height)}:
            {sameHeight.map(e => (
              <button key={e.parent} type="button" onClick={() => select(e.parent)} title={factsTitle(e)}
                className="rounded-full border border-border px-2.5 py-0.5 text-foreground hover:bg-foreground/5">
                <KindChip kind={e.kind} title={factsTitle(e)} alsoInvalid={!!e.invalid_coinbase && e.kind !== "invalid_coinbase"} />
              </button>
            ))}
          </div>
        )}
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
          Forks
          <a href={METHODOLOGY} target="_blank" rel="noreferrer" title="How the kinds are inferred"
            className="text-foreground/60 hover:text-foreground" aria-label="Methodology">
            <Info className="h-4 w-4" />
          </a>
        </h1>
        <p className="mt-1 text-sm text-foreground/60">Templates built on a block other than our best one · {RANGE_TEXT[shownRange]}</p>
      </div>
      {body}
    </div>
  );
}
