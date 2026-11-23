"use client";

import React, { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Info } from "lucide-react";
import HeightForkTimeline from "./HeightForkTimeline";
import ForkTimeline, { MiniForkTimeline } from "./ForkTimeline";
import { isRace, raceRows, type RaceRow } from "@/lib/forkRaces";
import type { ArrivalBlock } from "@/lib/forkTimelineAxis";
import { reverseHex } from "@/utils/formatters";
import type { ParentKind } from "@/lib/parentKind";
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
    stale_block: { height: number; header_source: string | null; miner: string | null; prev: string | null } | null;
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
const KIND_BG: Record<Kind, string> = {
  stale: "bg-[#1550a4] dark:bg-blue-500",
  bitcoin_block: "bg-sky-400",
  other_chain: "bg-violet-600 dark:bg-violet-500",
  invalid_parent: "bg-rose-600 dark:bg-rose-500",
  invalid_coinbase: "border-2 border-rose-500",
  undetermined: "bg-gray-500",
};
// Drill-in's template list: the episode's own parent in the text colour (the subject), amber = our best chain and
// blue = a known stale block (the fork timeline's colours), gray = another unknown parent
const LABELS: ParentLabel[] = ["this", "best", "stale", "other"];
const LABEL_TEXT: Record<ParentLabel, string> = { this: "this parent", best: "best chain", stale: "stale", other: "other" };
const LABEL_BG: Record<ParentLabel, string> = {
  this: "bg-foreground",
  best: "bg-amber-500",
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

// ---------------------------------------------------------------------------------------------------------------------
// Drill-in

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
    <div>
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
      {/* the checks as one quiet line: only the glyph carries the result */}
      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-foreground/60">
        {checks.map((c, i) => (
          <span key={c.label} className="inline-flex items-center gap-1.5 whitespace-nowrap">
            {i > 0 && <span aria-hidden className="text-foreground/30">·</span>}
            <span title={c.title}>
              <span className={c.ok === null ? "text-foreground/40" : c.ok ? "text-emerald-500/80" : "text-rose-500/80"}>
                {c.ok === null ? "?" : c.ok ? "✓" : "✗"}
              </span>{" "}{c.label}
            </span>
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5 pl-1">→ <KindChip kind={episode.kind} title={factsTitle(episode)} alsoInvalid={!!episode.invalid_coinbase && episode.kind !== "invalid_coinbase"} /></span>
      </div>
    </div>
  );
}

function DrillIn({ episode, range }: { episode: Episode; range: Range }) {
  const [drill, setDrill] = useState<{ parent: string; data: DrillResponse } | null>(null);
  const [showList, setShowList] = useState(false);
  const [shown, setShown] = useState(LIST_PAGE);
  useEffect(() => {
    const ctl = new AbortController();
    fetch(`/api/forks?parent=${episode.parent}&range=${range}&providers=0`, { signal: ctl.signal })
      .then(r => r.json())
      .then((d: DrillResponse) => setDrill({ parent: episode.parent, data: d }))
      .catch(e => { if (e?.name !== "AbortError") setDrill({ parent: episode.parent, data: { error: String(e) } }); });
    return () => ctl.abort();
  }, [episode.parent, range]);
  const data = drill?.parent === episode.parent ? drill.data : null;
  const templates = useMemo(() => data?.templates ?? [], [data]);
  const present = useMemo(() => new Set(templates.map(t => t.parent)), [templates]);

  return (
    <section className="mb-3 rounded-xl border border-border p-4" aria-label="Episode details">
      {!data && <p className="py-8 text-center text-xs text-foreground/60">Loading…</p>}
      {data?.error && <p className="text-sm text-red-500">{data.error}</p>}
      {data && !data.error && (
        <>
          {episode.kind !== "invalid_coinbase" && <WhyUnknown episode={episode} drill={data} />}
          <button type="button" className="mt-4 text-xs text-foreground/60 hover:text-foreground"
            onClick={() => setShowList(s => !s)} aria-expanded={showList}>
            {showList ? "▾" : "▸"} Templates ({fmtInt(templates.length)}{data.truncated ? "+" : ""})
            {data.clipped && <span className="text-foreground/50"> · first 30 min of {fmtDuration(episode.duration_ms)}</span>}
          </button>
          {showList && (
            <div className="mt-2 overflow-x-auto">
              <div className="mb-1 flex flex-wrap gap-3 text-xs text-foreground/60">
                {LABELS.filter(l => present.has(l)).map(l => (
                  <span key={l} className="inline-flex items-center gap-1.5">
                    <span className={`inline-block h-2.5 w-2.5 rounded-full ${LABEL_BG[l]}`} aria-hidden />{LABEL_TEXT[l]}
                  </span>
                ))}
              </div>
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
// Rows: one per race (lib/forkRaces.ts), its fork timeline from /api/forks/timeline

interface Lanes {
  height: number;
  active: string | null;
  from_ms: number;
  last_ms: number;
  parents: { hash: string; status: "canonical" | "stale" | "unknown" | null; kind: ParentKind | null }[];
  lanes: { pool: string; runs: [number, number, 0 | 1][]; end: number }[];
  blocks: ArrivalBlock[];
}

// Timelines are read as rows come into view, two at a time, each height once per page view; the latest asked first,
// so the rows on screen don't wait behind ones scrolled past.
const laneReads = new Map<number, Promise<Lanes | null>>();
let reading = 0;
const queued: (() => void)[] = [];
const waiting = new Map<number, () => void>();   // queued reads by height, so an urgent one can start at once
function readLanes(height: number, urgent = false): Promise<Lanes | null> {
  const known = laneReads.get(height);
  if (known) {
    const start = urgent ? waiting.get(height) : undefined;
    if (start) { queued.splice(queued.indexOf(start), 1); waiting.delete(height); start(); }
    return known;
  }
  const p = new Promise<Lanes | null>(resolve => {
    const run = () => {
      waiting.delete(height);
      reading++;
      fetch(`/api/forks/timeline?height=${height}`)
        .then(r => (r.ok ? r.json() : null)).catch(() => null)
        .then((v: Lanes | null) => { reading--; queued.pop()?.(); resolve(v); });
    };
    // the row a viewer jumped to or opened doesn't queue
    if (reading < 2 || urgent) run(); else { queued.push(run); waiting.set(height, run); }
  });
  laneReads.set(height, p);
  p.then(v => { if (!v) laneReads.delete(height); });
  return p;
}

function useLanes(heights: number[], wanted: boolean, urgent: boolean): Map<number, Lanes | null> | null {
  const key = heights.join(",");
  const [got, setGot] = useState<{ key: string; lanes: Map<number, Lanes | null> } | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    Promise.all(key.split(",").map(Number).map(h => readLanes(h, urgent).then(l => [h, l] as const)))
      .then(all => { if (live) setGot({ key, lanes: new Map(all) }); });
    return () => { live = false; };
  }, [key, wanted, urgent]);
  return got?.key === key ? got.lanes : null;
}

const nsHex = (ms: number) => Math.round(ms * 1_000_000).toString(16);

/** The fork chart's inputs for one height's runs (the chart is shared with the height page). */
function chartProps(l: Lanes) {
  const notifications = l.lanes.flatMap(lane => lane.runs.map(([at, p, bad]) => ({
    pool_name: lane.pool, timestamp: nsHex(l.from_ms + at), prev_hash: reverseHex(l.parents[p].hash), invalid: bad === 1,
  })));
  const ends = Object.fromEntries(l.lanes.map(lane => [lane.pool, Math.round((l.from_ms + lane.end) * 1_000_000)]));
  const status = Object.fromEntries(l.parents.filter(p => p.status).map(p => [p.hash, p.status!]));
  const kind = Object.fromEntries(l.parents.filter(p => p.kind).map(p => [p.hash, p.kind!]));
  return { notifications, ends, canonicalBlockHash: l.active ?? undefined, prevHashStatus: status, prevHashKind: kind, blocks: l.blocks };
}

const SIDE_DOT: Record<string, string> = {
  canonical: "bg-amber-600 dark:bg-amber-500",
  stale: "bg-[#1550a4] dark:bg-blue-500",
  bitcoin_block: "bg-sky-400",
  other_chain: "bg-violet-600 dark:bg-violet-500",
  invalid_parent: "bg-rose-600 dark:bg-rose-500",
  undetermined: "bg-gray-500",
};
const SIDE_TEXT: Record<string, string> = {
  canonical: "text-amber-600 dark:text-amber-500",
  stale: "text-[#1550a4] dark:text-blue-400",
  bitcoin_block: "text-sky-500 dark:text-sky-400",
  other_chain: "text-violet-600 dark:text-violet-400",
  invalid_parent: "text-rose-600 dark:text-rose-400",
  undetermined: "text-gray-500",
};

interface Side {
  hash: string; tone: string; label: string; title: string;
  pools: { pool: string; to: string | null; invalid: boolean; visit?: boolean }[];
}

/**
 * The row's blocks, each with the pools whose first work at that height was on it: the block that stayed first, then
 * the others in the order work on them first arrived. A pool that later moved has an arrow in the colour of where it
 * went; one with invalid work is rose. Pools the summary lists that the timeline doesn't show on a block (work at
 * another height of the row) join the side of the block they built on. A block at the height before that no pool
 * started on still gets its side (it may be the one that stayed), listing the pools that built on it for a while,
 * outlined.
 */
/** A side that is a block at the height before (ours or a stale one): two of them make the row a race. */
const isBlockSide = (s: Side) => s.tone === "canonical" || s.tone === "stale";

function sidesOf(row: RaceRow<Episode>, lanes: Map<number, Lanes | null> | null): Side[] {
  const sides = new Map<string, Side>();
  const toneOf = (p: Lanes["parents"][number]) => (p.status === "canonical" ? "canonical" : p.status === "stale" ? "stale" : p.kind ?? "undetermined");
  const add = (hash: string, tone: string, label: string, title: string) => {
    if (!sides.has(hash)) sides.set(hash, { hash, tone, label, title, pools: [] });
    return sides.get(hash)!;
  };
  const placed = new Set<string>();
  const labelOf = (p: Lanes["parents"][number], minerOf: (hash: string) => string | null) => {
    const tone = toneOf(p);
    if (tone !== "canonical" && tone !== "stale") return KIND_LABEL[tone as Kind];
    return minerOf(p.hash) ?? (tone === "stale" ? row.episodes.find(e => e.parent === p.hash)?.facts.stale_block?.miner ?? null : null) ?? "unknown";
  };
  const titleOf = (p: Lanes["parents"][number], h: number) => {
    const tone = toneOf(p);
    return `${tone === "canonical" ? "our best block" : tone === "stale" ? "a stale block" : KIND_LABEL[tone as Kind].toLowerCase()} at ${fmtInt(h - 1)} · ${p.hash}`;
  };
  for (const h of row.heights) {
    const l = lanes?.get(h);
    if (!l) continue;
    const minerOf = (hash: string) => l.blocks.find(b => b.hash === hash)?.miner ?? null;
    for (const lane of [...l.lanes].sort((a, b) => a.pool.toLowerCase().localeCompare(b.pool.toLowerCase()))) {
      const first = l.parents[lane.runs[0][1]];
      // where it went: the last other block it built on (it may have come back)
      const other = [...lane.runs].reverse().find(r => r[1] !== lane.runs[0][1]);
      if (h !== row.heights[0] && (first.status === "canonical" || placed.has(lane.pool))) continue;
      const tone = toneOf(first);
      add(first.hash, tone, labelOf(first, minerOf), titleOf(first, h)).pools.push({
        pool: lane.pool, to: other ? toneOf(l.parents[other[1]]) : null, invalid: lane.runs.some(r => r[2] === 1),
      });
      placed.add(lane.pool);
    }
    if (h !== row.heights[0]) continue;
    // a block no pool started on: still a side of the race, with the pools that visited it
    l.parents.forEach((par, i) => {
      if (sides.has(par.hash) || (par.status !== "canonical" && par.status !== "stale")) return;
      const side = add(par.hash, toneOf(par), labelOf(par, minerOf), titleOf(par, h));
      for (const lane of [...l.lanes].sort((a, b) => a.pool.toLowerCase().localeCompare(b.pool.toLowerCase()))) {
        if (lane.runs.some(r => r[1] === i)) side.pools.push({ pool: lane.pool, to: null, invalid: lane.runs.some(r => r[1] === i && r[2] === 1), visit: true });
      }
    });
  }
  // before the timeline is in (or for another chain's row): the summary's own pools, on the episode's parent
  for (const e of row.episodes) {
    const tone = e.kind === "stale" ? "stale" : e.kind === "invalid_coinbase" ? "canonical" : e.kind;
    for (const p of e.pools) {
      if (placed.has(p.pool)) continue;
      const label = e.kind === "stale" ? e.facts.stale_block?.miner ?? "unknown" : e.kind === "invalid_coinbase" ? "our best block" : KIND_LABEL[e.kind];
      add(e.parent, tone, label, `${KIND_LABEL[e.kind]} · ${e.parent}`).pools.push({
        pool: p.pool, to: null, invalid: e.invalid_coinbase?.pools.some(x => x.pool === p.pool) ?? false,
      });
      placed.add(p.pool);
    }
  }
  return [...sides.values()].sort((a, b) => (a.tone === "canonical" ? -1 : 0) - (b.tone === "canonical" ? -1 : 0));
}

/** The epoch a row's template providers are judged by: the one our tip was in when its work began (providerEpoch). */
const providerEpochOf = (row: RaceRow<Episode>) => Math.floor(((row.episodes[0].facts.tip_at_first ?? row.heights[0] - 1) + 1) / EPOCH);

/**
 * A side's tiles in runs: the pools that share a template provider together (largest first), then the rest alone, in
 * the side's order.
 */
function clusterTiles<T extends { pool: string }>(pools: T[], providers: string[][] | null): T[][] {
  if (!providers) return pools.map(p => [p]);
  const groupOf = new Map<string, number>();
  providers.forEach((g, i) => g.forEach(f => groupOf.set(f, i)));
  const by = new Map<number, T[]>();
  const alone: T[][] = [];
  for (const p of pools) {
    const g = groupOf.get(p.pool);
    if (g === undefined) alone.push([p]);
    else by.set(g, [...(by.get(g) ?? []), p]);
  }
  const groups = [...by.values()].filter(g => g.length > 1).sort((a, b) => b.length - a.length);
  for (const g of by.values()) if (g.length === 1) alone.push(g);
  const order = new Map(pools.map((p, i) => [p.pool, i]));
  alone.sort((a, b) => order.get(a[0].pool)! - order.get(b[0].pool)!);
  return [...groups, ...alone];
}

function RaceRowView({ row, open, highlighted, target, onToggle, onHover, range, rowRef, providers }: {
  providers: string[][] | null;
  row: RaceRow<Episode>; open: boolean; highlighted: boolean; target: boolean; onToggle: () => void; onHover: (on: boolean) => void;
  range: Range; rowRef: (el: HTMLElement | null) => void;
}) {
  const [seen, setSeen] = useState(false);
  const own = useRef<HTMLElement | null>(null);
  const timed = row.kind !== "other_chain";
  useEffect(() => {
    if (!timed || seen || !own.current) return;
    const io = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) setSeen(true); }, { rootMargin: "300px 0px" });
    io.observe(own.current);
    return () => io.disconnect();
  }, [timed, seen]);
  // hovering only outlines; the row a viewer jumped to, or opened, is read first
  const lanes = useLanes(row.heights, timed && (seen || open || target), open || target);
  const sides = useMemo(() => sidesOf(row, lanes), [row, lanes]);
  const first = lanes?.get(row.heights[0]) ?? null;
  const charts = useMemo(() => new Map(row.heights.map(h => {
    const l = lanes?.get(h);
    return [h, l ? chartProps(l) : null] as const;
  })), [row.heights, lanes]);
  const mini = first ? charts.get(row.heights[0]) ?? null : null;
  const primary = row.episodes[0];
  const [evidence, setEvidence] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const head = useRef<HTMLButtonElement | null>(null);
  const kinds = [...new Set(row.episodes.map(e => e.kind))];

  return (
    <section ref={el => { own.current = el; rowRef(el); }} data-row={row.key}
      className={`scroll-mt-4 border-t border-border py-3 ${highlighted ? "bg-foreground/5" : ""}`}
      onPointerEnter={() => onHover(true)} onPointerLeave={() => onHover(false)}>
      <button ref={head} type="button" onClick={onToggle} aria-expanded={open}
        className="flex w-full gap-3 text-left max-sm:block max-sm:relative max-sm:pl-5">
        <span aria-hidden className={`mt-1 inline-block h-2 w-2 shrink-0 border-b-2 border-r-2 border-foreground/60 transition-transform max-sm:absolute max-sm:left-0 max-sm:top-0.5 ${open ? "rotate-45" : "-rotate-45"}`} />
        <span className="w-24 shrink-0 max-sm:mb-2 max-sm:flex max-sm:w-auto max-sm:items-baseline max-sm:gap-2.5">
          <span className="block font-mono text-sm font-semibold">{fmtInt(row.heights[0])}{row.heights.length > 1 ? ` – ${fmtInt(row.heights[row.heights.length - 1])}` : ""}</span>
          <span className="block text-[10px] text-foreground/55" title={fmtLocal(row.first_ms)}>{fmtUtc(row.first_ms).slice(0, 10)}</span>
          <span className="block text-[10px] text-foreground/55">{isRace(row.kind) ? "race · " : ""}{fmtDuration(row.last_ms - row.first_ms)}</span>
          {kinds.filter(k => k !== "stale").map(k => <span key={k} className="mt-1 block text-[10px] leading-3 text-foreground/70 [&>span]:whitespace-normal [&>span]:text-[10px]"><KindChip kind={k} /></span>)}
        </span>
        <span className="block min-w-0 flex-1">
          {sides.map((s, i) => (
            <Fragment key={s.hash}>
            {i > 0 && isBlockSide(s) && isBlockSide(sides[i - 1]) && (
              <span className="-mt-0.5 mb-1 block w-28 pl-4 text-[10px] font-semibold uppercase tracking-wider text-foreground/45 max-sm:w-auto">vs</span>
            )}
            <span className="mb-1.5 flex gap-2 max-sm:block">
              <span className="flex w-28 shrink-0 items-start gap-1.5 self-start text-xs leading-4 max-sm:mb-1 max-sm:w-auto" title={s.title}>
                <span className={`mt-[3px] inline-block h-2.5 w-2.5 shrink-0 rounded-sm ${SIDE_DOT[s.tone]}`} aria-hidden />
                <span className="min-w-0 break-words max-sm:flex max-sm:items-baseline max-sm:gap-2">
                  {s.label}
                  {isBlockSide(s) && <span className="block font-mono text-[10px] leading-4 text-foreground/50">…{s.hash.slice(-8)}</span>}
                </span>
              </span>
              <span className="flex min-w-0 flex-wrap content-start items-start gap-0.5 self-start">
                {clusterTiles(s.pools, providers).map(run => {
                  const tiles = run.map(p => (
                  <span key={p.pool} className={`rounded-sm px-1 text-[10px] leading-4 whitespace-nowrap ${p.visit ? `border border-dashed ${p.invalid ? "border-rose-500" : "border-foreground/40"} leading-[14px]` : p.invalid ? "bg-rose-600 text-white dark:bg-rose-500" : "bg-foreground/10"}`}
                    title={`${p.pool}${p.invalid ? " · invalid work" : ""}${p.visit ? " · built on it for a while, started on another block" : p.to ? " · also built on another block" : ""}`}>
                    {p.pool}{p.to && <span className={p.invalid ? "" : SIDE_TEXT[p.to]}> →</span>}
                  </span>
                ));
                  return run.length > 1
                    ? <span key={run[0].pool} className="inline-flex flex-wrap gap-0.5 rounded border border-foreground/30 p-px"
                        title={`one template provider: ${run.map(p => p.pool).join(", ")}`}>{tiles}</span>
                    : tiles;
                })}
              </span>
            </span>
            </Fragment>
          ))}
          {timed && !open && (
            <span className="mt-2 block min-h-6">
              {mini ? <MiniForkTimeline {...mini} />
                : lanes ? <span className="block text-[11px] text-foreground/50">timeline unavailable</span>
                : <span className="block h-20 animate-pulse rounded-sm bg-foreground/5" />}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="mt-3">
          {timed ? row.heights.map(h => {
            const c = charts.get(h);
            return (
              <div key={h} className="mb-4">
                {row.heights.length > 1 && <div className="mb-1 text-xs text-foreground/60">at {fmtInt(h)}</div>}
                {c ? <ForkTimeline {...c} embedded />
                  : <p className="py-6 text-center text-xs text-foreground/60">{lanes ? "Timeline unavailable." : "Loading…"}</p>}
              </div>
            );
          }) : row.heights.map(h => <HeightForkTimeline key={h} height={h} kindHint={{ [primary.parent]: primary.kind as ParentKind }} />)}
          <button type="button" className="mb-2 text-xs text-foreground/60 hover:text-foreground"
            onClick={() => setEvidence(v => !v)} aria-expanded={evidence}>
            {evidence ? "▾" : "▸"} Evidence and templates
          </button>
          {evidence && row.episodes.map(e => <DrillIn key={e.parent} episode={e} range={range} />)}
          <button ref={closeRef} type="button" onClick={() => { onToggle(); requestAnimationFrame(() => { own.current?.scrollIntoView({ block: "nearest" }); head.current?.focus({ preventScroll: true }); }); }}
            className="sticky bottom-0 z-10 mt-2 flex h-8 w-full items-center justify-center gap-2 rounded border border-border bg-muted text-xs shadow-[0_-6px_12px_-6px_rgba(0,0,0,0.35)] hover:bg-card">
            <span aria-hidden className="inline-block h-1.5 w-1.5 translate-y-0.5 rotate-[225deg] border-b-2 border-r-2 border-current" />
            Collapse {fmtInt(row.heights[0])}
          </button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The strip: every race of all history, one square each, a column per difficulty epoch

interface StripResponse {
  enabled?: boolean;
  tip_height?: number | null;
  from_height?: number | null;
  other_chain_epochs?: number[];
  rows?: [number, number, string, 0 | 1, string][];
  error?: string;
}

function HistoryStrip({ strip, range, showOther, active, onPick, onHover }: {
  strip: StripResponse; range: Range; showOther: boolean; active: string | null;
  onPick: (key: string, height: number) => void; onHover: (key: string | null) => void;
}) {
  const [label, setLabel] = useState<string | null>(null);
  const rows = strip.rows ?? [];
  if (rows.length === 0 || strip.tip_height == null) return null;
  const from = Math.min(strip.from_height ?? Infinity, ...rows.map(r => r[0]));
  const first = Math.floor(from / EPOCH), last = Math.floor(strip.tip_height / EPOCH);
  const cols: (typeof rows)[] = Array.from({ length: last - first + 1 }, () => []);
  for (const r of [...rows].sort((a, b) => a[0] - b[0])) cols[Math.floor(r[0] / EPOCH) - first]?.push(r);
  const other = new Set(strip.other_chain_epochs ?? []);
  const inRange = (pos: number) => RANGE_BLOCKS_PAGE[range] === null || pos > strip.tip_height! - RANGE_BLOCKS_PAGE[range]!;
  const races = rows.filter(r => r[2] === "stale" || r[2] === "bitcoin_block").length;
  const what = (r: (typeof rows)[number]) => `${fmtInt(r[1])} · ${r[2] === "stale" || r[2] === "bitcoin_block" ? "race" : KIND_LABEL[r[2] as Kind].toLowerCase()}${r[3] ? " · invalid work" : ""}`;
  return (
    <div className="mb-6">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1.5"><span className={`inline-block h-2.5 w-2.5 rounded-sm ${KIND_BG.stale}`} />Race {fmtInt(races)}</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-rose-600 dark:bg-rose-500" />Invalid {fmtInt(rows.filter(r => r[3]).length)}</span>
        <span className="text-foreground/55">races our feeds built on · 1 column = 1 epoch</span>
      </div>
      <div className="flex items-end gap-px" onPointerLeave={() => { setLabel(null); onHover(null); }}>
        {cols.map((c, i) => (
          // on a phone a square is a few pixels wide: a tap anywhere in its column opens the column's newest row
          <div key={i} className={`flex min-w-0 flex-1 flex-col-reverse items-center gap-0.5 border-b-2 border-border pb-0.5 max-sm:cursor-pointer ${inRange((first + i + 1) * EPOCH - 1) ? "" : "opacity-40"}`}
            onClick={e => { if (c.length && window.matchMedia("(max-width: 639px)").matches) { e.preventDefault(); const r = c[c.length - 1]; onPick(r[4], r[1]); } }}>
            {c.map(r => (
              <button key={r[4]} type="button" aria-label={what(r)}
                className={`aspect-square w-full max-w-3.5 rounded-[1px] max-sm:pointer-events-none ${r[2] === "stale" || r[2] === "bitcoin_block" ? (r[3] ? "bg-[linear-gradient(var(--race)_50%,var(--bad)_50%)]" : KIND_BG.stale) : "bg-rose-600 dark:bg-rose-500"} ${active === r[4] ? "outline-2 outline-offset-1 outline-foreground" : "hover:outline-2 hover:outline-offset-1 hover:outline-foreground/70"}`}
                style={{ ["--race" as string]: "var(--fork-race)", ["--bad" as string]: "var(--fork-bad)" }}
                onPointerEnter={() => { setLabel(what(r)); onHover(r[4]); }} onFocus={() => setLabel(what(r))}
                onClick={() => onPick(r[4], r[1])} />
            ))}
          </div>
        ))}
      </div>
      {showOther && (
        <div className="mt-1 flex gap-px" aria-label="Epochs with another chain's work">
          {cols.map((_, i) => <div key={i} className={`h-1 min-w-0 flex-1 ${other.has(first + i) ? "bg-violet-600 dark:bg-violet-500" : ""}`} />)}
        </div>
      )}
      <div className="relative mt-1 h-4 text-[10px] text-foreground/55">
        {cols.map((_, i) => (i > 0 && i % 20 === 0 && i < cols.length - 6
          ? <span key={i} className="absolute" style={{ left: `${(i / cols.length) * 100}%` }}>{fmtInt((first + i) * EPOCH)}</span> : null))}
      </div>
      <div className="h-4 text-[10px] text-foreground/70" role="status">{label ?? ""}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

const EPOCH = 2016;
const RANGE_BLOCKS_PAGE: Record<Range, number | null> = { "6e": 6 * EPOCH, "26e": 26 * EPOCH, all: null };

/**
 * The address for what's shown (shareable): the opened row's short link (/forks/<height>[/<kind>], no range:
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
  const [strip, setStrip] = useState<StripResponse | null>(null);
  const [providers, setProviders] = useState<Record<number, string[][]> | null>(null);
  const [kind, setKind] = useState<Kind | "all">("all");
  const [showOther, setShowOther] = useState(false);
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());
  const [lastOpened, setLastOpened] = useState<string | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const [jump, setJump] = useState<{ key: string; height: number; open: boolean } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const rowEls = useRef(new Map<string, HTMLElement>());

  const load = useCallback((r: Range) => fetch(`/api/forks?range=${r}&providers=0`)
    .then(res => res.json())
    .then((d: SummaryResponse) => setLoaded(m => ({ ...m, [r]: d })))
    .catch(e => setLoaded(m => ({ ...m, [r]: { enabled: true, supported: true, error: String(e) } }))), []);

  useEffect(() => {
    fetch("/api/forks?view=strip").then(r => r.json()).then(setStrip).catch(() => setStrip({ error: "unavailable" }))
      // then the template providers, which only group the tiles: rows show ungrouped until they're in
      .then(() => fetch("/api/forks?view=providers")).then(r => r.json())
      .then((p: { epochs?: Record<number, string[][]> }) => setProviders(p.epochs ?? {})).catch(() => {});
  }, []);

  useEffect(() => {
    // A short link's episode (resolved on the server), else a link's ?range=… and an older link's ?parent=… (the
    // server redirects those to the short link when it can; one it couldn't resolve is looked up here).
    if (initialRange && initialParent) {
      load(initialRange).then(() => setJump({ key: initialParent, height: 0, open: true }));
      return;
    }
    const q = new URLSearchParams(window.location.search);
    const asked = q.get("range") ?? "";
    const legacy = Object.hasOwn(LEGACY_RANGES, asked);
    const r = RANGES.find(x => x === (legacy ? LEGACY_RANGES[asked] : asked)) ?? DEFAULT_RANGE;
    const p = q.get("parent");
    load(r).then(() => {
      setRange(r);
      if (p && /^[0-9a-f]{64}$/i.test(p)) setJump({ key: p.toLowerCase(), height: 0, open: true });
    });
  }, [load, initialRange, initialParent]);
  const summary = loaded[range] ?? null;

  const all = useMemo(() => summary?.episodes ?? [], [summary]);
  const rows = useMemo(() => [
    ...raceRows(all.filter(e => e.kind !== "other_chain")),
    ...raceRows(all.filter(e => e.kind === "other_chain")),
  ].sort((a, b) => b.position - a.position || b.first_ms - a.first_ms), [all]);
  const rowOf = useCallback((parentOrKey: string) => rows.find(r => r.key === parentOrKey || r.episodes.some(e => e.parent === parentOrKey)) ?? null, [rows]);
  const matches = useCallback((r: RaceRow<Episode>, k: Kind | "all") => {
    if (r.kind === "other_chain") return k === "other_chain" || (k === "all" && showOther);
    if (k === "all") return true;
    if (k === "invalid_parent") return r.invalid;
    return r.episodes.some(e => e.kind === k);
  }, [showOther]);
  const shown = useMemo(() => rows.filter(r => matches(r, kind)), [rows, kind, matches]);
  const counts = useMemo(() => {
    const c: Partial<Record<Kind, number>> = {};
    for (const r of rows) for (const k of CHIPS) if (k === "other_chain" ? r.kind === "other_chain" : r.kind !== "other_chain" && matches(r, k)) c[k] = (c[k] ?? 0) + 1;
    return c;
  }, [rows, matches]);

  // A jump (a square, a link): find the row, widening the range when this one doesn't have it; then scroll to it.
  useEffect(() => {
    if (!jump || !summary?.episodes) return;
    const row = rowOf(jump.key);
    if (!row) {
      const next = RANGES[RANGES.indexOf(range) + 1];
      if (next) { setRange(next); if (!loaded[next]) load(next); }
      else { setNote(jump.height ? `${fmtInt(jump.height)} isn't in the list` : null); setJump(null); }
      return;
    }
    if (row.kind === "other_chain") setShowOther(true);
    if (!matches(row, kind) && row.kind !== "other_chain") setKind("all");
    if (jump.open) { setOpenKeys(s => new Set(s).add(row.key)); setLastOpened(row.key); }
    setHoverKey(row.key);
    setTargetKey(row.key);
    setNote(null);
    requestAnimationFrame(() => rowEls.current.get(row.key)?.scrollIntoView({ block: "start" }));
    setJump(null);
  }, [jump, summary, rowOf, range, loaded, load, kind, matches]);

  const toggle = (key: string) => setOpenKeys(s => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else { n.add(key); setLastOpened(key); }
    return n;
  });
  const opened = lastOpened && openKeys.has(lastOpened) ? rowOf(lastOpened) : [...openKeys].map(k => rowOf(k)).find(Boolean) ?? null;

  // Keep the address on what's shown (shareable), once the range's summary is in: history.replaceState, which Next.js
  // keeps in step with its router, so no navigation, no server render, no scroll.
  useEffect(() => {
    if (!summary?.episodes || jump) return;
    const next = pageUrl(opened?.episodes[0] ?? null, all, range);
    if (window.location.pathname + window.location.search !== next) window.history.replaceState(null, "", next);
  }, [summary, opened, all, range, jump]);

  const chooseRange = (r: Range) => {
    if (r === range) return;
    setRange(r);
    if (!loaded[r]) load(r);
  };
  const rangePicker = (
    <div className="ml-auto inline-flex overflow-hidden rounded-full border border-border text-xs" role="group" aria-label="Range">
      {RANGES.map(r => (
        <button key={r} onClick={() => chooseRange(r)} aria-pressed={range === r}
          className={`px-3 py-1.5 transition-colors ${range === r ? "bg-foreground/10" : "text-foreground/60 hover:bg-foreground/5"}`}>
          {RANGE_LABEL[r]}
        </button>
      ))}
    </div>
  );
  const chip = (k: Kind | "all", pressed: boolean, onClick: () => void, n: number) => (
    <button key={k} onClick={onClick} aria-pressed={pressed}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors ${pressed ? "border-foreground/60 bg-foreground/10" : "border-border hover:bg-foreground/5"}`}>
      {k !== "all" && <span className={`inline-block h-2.5 w-2.5 rounded-full ${KIND_BG[k]}`} aria-hidden />}
      {k === "all" ? "All" : CHIP_LABEL[k] ?? KIND_LABEL[k]}
      <span className="font-mono text-foreground/60">{fmtInt(n)}</span>
    </button>
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
      <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Filter by kind">
        {chip("all", kind === "all", () => setKind("all"), rows.filter(r => r.kind !== "other_chain").length + (showOther ? counts.other_chain ?? 0 : 0))}
        {CHIPS.filter(k => k !== "other_chain" && counts[k]).map(k => chip(k, kind === k, () => setKind(k), counts[k]!))}
        {counts.other_chain ? chip("other_chain", showOther || kind === "other_chain", () => {
          if (kind === "other_chain") { setKind("all"); setShowOther(false); } else setShowOther(v => !v);
        }, counts.other_chain) : null}
        {rangePicker}
      </div>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-foreground/65">
        <span className="inline-flex items-center gap-1.5"><span className={`inline-block h-2.5 w-2.5 rounded-sm ${SIDE_DOT.canonical}`} />on the block that stayed</span>
        <span className="inline-flex items-center gap-1.5"><span className={`inline-block h-2.5 w-2.5 rounded-sm ${SIDE_DOT.stale}`} />on the stale block</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-rose-600 dark:bg-rose-500" />invalid work</span>
      </div>
      {shown.map(r => (
        <RaceRowView key={r.key} row={r} range={range} providers={providers?.[providerEpochOf(r)] ?? null} open={openKeys.has(r.key)} highlighted={hoverKey === r.key} target={targetKey === r.key}
          onToggle={() => toggle(r.key)} onHover={on => setHoverKey(on ? r.key : null)}
          rowRef={el => { if (el) rowEls.current.set(r.key, el); else rowEls.current.delete(r.key); }} />
      ))}
      {shown.length === 0 && <p className="py-6 text-center text-xs text-foreground/60">None.</p>}
    </>
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 [--fork-race:#1550a4] [--fork-bad:#e11d48] dark:[--fork-race:#3b82f6] dark:[--fork-bad:#f43f5e]">
      <div className="mb-5">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          Forks
          <a href={METHODOLOGY} target="_blank" rel="noreferrer" title="How the kinds are inferred"
            className="text-foreground/60 hover:text-foreground" aria-label="Methodology">
            <Info className="h-4 w-4" />
          </a>
        </h1>
        <p className="mt-1 text-sm text-foreground/60">Templates built on a block other than our best one · {RANGE_TEXT[range]}</p>
      </div>
      {/* all history, whatever range the list below is loading */}
      {strip?.rows && <HistoryStrip strip={strip} range={range} showOther={showOther} active={hoverKey}
        onPick={(key, height) => setJump({ key, height, open: false })} onHover={setHoverKey} />}
      {note && <p className="-mt-4 mb-4 text-xs text-foreground/60">{note}</p>}
      {body}
    </div>
  );
}
