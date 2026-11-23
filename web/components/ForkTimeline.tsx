"use client";

import React, { useMemo, useState } from "react";
import { formatPrevBlockHash, reverseHex } from "@/utils/formatters";
import type { LaneStatus } from "@/lib/forkStatus";
import type { ParentKind } from "@/lib/parentKind";
import {
  axisDomain, buildTimeZones, mapTimeToVisual, placeBlockMarkers, type ArrivalBlock, type BlockMarker, type TimeZone,
  markerBlocks,
} from "@/lib/forkTimelineAxis";
import { useElementWidth } from "@/visuals/framework/useElementWidth";

interface MiningNotification {
  pool_name?: string | null;
  timestamp: string;
  prev_hash: string;
  /** Work the height's invalid-coinbase finding is about (the Forks page's runs): drawn rose. */
  invalid?: boolean;
  /** An empty template (no transactions; the Forks page's runs): drawn as a thin bar. */
  empty?: boolean;
}

interface ForkTimelineProps {
  notifications: MiningNotification[];
  canonicalBlockHash?: string;
  /**
   * Per prev hash (block hash, display order), from /api/analysis-data's prev_hash_status (#212). The Forks page's runs
   * also mark the block before (height - 2) a pool went back to as `previous`: drawn neutral, not hatched.
   */
  prevHashStatus?: Record<string, LaneStatus> | null;
  /** Per unknown prev hash (block hash, display order): the kind the server infers (lib/parentKind.ts). */
  prevHashKind?: Record<string, ParentKind> | null;
  /** The blocks at height - 1 and height (best and stale) with our node's seen time: a marker each where it reached us. */
  blocks?: ArrivalBlock[] | null;
  /** Pools with an invalid coinbase at this height (the backend's finding): a rose ✗ on their row. */
  invalidCoinbasePools?: string[] | null;
  /**
   * Kinds the caller already knows (block hash, display order), used only where the server gave no status: a height
   * with no stored block at height - 1 (another chain's) has none, but the Forks page knows its episode's kind.
   */
  kindHint?: Record<string, ParentKind> | null;
  /** The chart's heading (default "Fork"). */
  title?: string;
  /**
   * Where each pool's last run ends (ns, the notifications' clock): when it moved on to the next height. Without it a
   * run lasts to the last template of any pool. Each end also counts as an event of the axis.
   */
  ends?: Record<string, number> | null;
  /** Inside a Forks row: no heading, sort or legend (the row has them), no total. */
  embedded?: boolean;
}

const PREV_HASH_COLORS = [
  "#3b82f6", // blue-500
  "#f59e0b", // amber-500
  "#10b981", // emerald-500
  "#f43f5e", // rose-500
  "#8b5cf6", // violet-500
  "#06b6d4", // cyan-500
];
const CANONICAL_HASH_COLOR = "#f59e0b"; // amber-500
const INVALID_COLOR = "#f43f5e"; // rose-500: work the height's invalid-coinbase finding is about
const STALE_HASH_COLOR = "#1550a4"; // slate-500 (muted/disabled look)
const UNKNOWN_HASH_COLOR = "#6b7280"; // gray-500: a parent we have no block for, kind undetermined
const PREVIOUS_HASH_COLOR = "hsl(var(--muted-foreground))"; // the block before (height - 2) a pool went back to: neutral
// Unknown parents by inferred kind, in the Forks page's colours: a block with Bitcoin's proof of work that we never
// recorded is in the stale family (a lighter blue), another chain's block violet, a parent that isn't a valid block rose.
const KIND_COLOR: Record<ParentKind, string> = {
  bitcoin_block: "#38bdf8", // sky-400
  other_chain: "#7c3aed", // violet-600
  invalid_parent: "#e11d48", // rose-600
  undetermined: UNKNOWN_HASH_COLOR,
};
const KIND_LABEL: Record<ParentKind, string> = {
  bitcoin_block: "Unrecorded block",
  other_chain: "Other chain",
  invalid_parent: "Invalid",
  undetermined: "Unknown",
};
const KIND_TEXT: Record<ParentKind, string> = {
  bitcoin_block: "text-red-400",
  other_chain: "text-violet-400",
  invalid_parent: "text-rose-400",
  undetermined: "text-muted-foreground",
};

/**
 * Status of each prev hash for the legend, colors and tooltips. `hash` and `canonicalRaw` are in the timeline's
 * internal (template) order; the server's statuses are keyed by block hash (display order), hence reverseHex.
 * With server statuses, "stale" means a block we know that isn't the best parent, and anything else that isn't
 * canonical is "unknown". Without them (older API), a non-canonical parent is "unknown": we can't tell it's a block.
 */
export function prevHashStatusOf(
  hash: string,
  canonicalRaw: string | null,
  serverStatus?: Record<string, LaneStatus> | null,
): LaneStatus | null {
  const s = serverStatus?.[reverseHex(hash).toLowerCase()];
  if (s === "previous") return "previous";
  if (canonicalRaw === null) return null;
  if (hash === canonicalRaw) return "canonical";
  return s === "stale" ? "stale" : "unknown";
}

const STATUS_LABEL: Record<LaneStatus, string> = {
  canonical: "active chain",
  stale: "stale",
  unknown: "unknown",
  previous: "the block before",
};

/** The tooltip label: the status, or for an unknown parent its inferred kind. */
function labelOf(status: LaneStatus | null, kind: ParentKind | undefined): string | null {
  if (status === null) return null;
  if (status === "unknown" && kind) return KIND_LABEL[kind].toLowerCase();
  return STATUS_LABEL[status];
}

function parseTimestampToNs(ts: string): number {
  if (!ts) return 0;
  const trimmed = ts.trim();

  if (/^[0-9a-fA-F]+$/.test(trimmed)) {
    const ns = parseInt(trimmed, 16);
    return Number.isFinite(ns) ? ns : 0;
  }

  const isoMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?/);
  if (isoMatch) {
    const baseMs = Date.parse(`${isoMatch[1]}T${isoMatch[2]}Z`);
    if (!Number.isNaN(baseMs)) {
      const nanoStr = (isoMatch[3] || "").padEnd(9, "0").slice(0, 9);
      return Math.max(0, baseMs) * 1_000_000 + parseInt(nanoStr, 10);
    }
  }

  const parsedMs = Date.parse(trimmed);
  if (!Number.isNaN(parsedMs)) return Math.max(0, parsedMs) * 1_000_000;
  return 0;
}

interface TimelineSegment {
  startNs: number;
  endNs: number;
  prevHash: string;
  invalid?: boolean;
  empty?: boolean;
}

interface VisualSegment {
  leftPct: number;
  widthPct: number;
  prevHash: string;
  tooltip: string;
  isStale: boolean;
  invalid: boolean;
  empty: boolean;
}

interface PoolTimelineData {
  poolName: string;
  visualSegments: VisualSegment[];
  initialHash: string;
  switched: boolean;
  firstNs: number;
}

export function formatRelativeTime(ns: number): string {
  const sec = ns / 1_000_000_000;
  if (sec < 0.001) return "0s";
  if (sec < 1) return `${(sec * 1000).toFixed(0)}ms`;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  // whole seconds up to two minutes, so neighbouring ticks don't round to the same minute ("1.2m 1.2m")
  if (sec < 120) return `${Math.round(sec)}s`;
  if (sec < 7200) return `${(sec / 60).toFixed(1)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

const fmtHeight = (h: number) => h.toLocaleString("en-US");

function markerTitle(m: BlockMarker): string {
  const at = new Date(m.seenMs).toISOString().slice(11, 23);
  const when = m.firstWork ? "first built on by our feeds" : m.staleOnly ? "first recorded" : "reached us";
  return `block ${fmtHeight(m.height)} · ${m.best ? "best chain" : "stale"} · ${when} ${at} UTC${m.miner ? ` · mined by ${m.miner}` : ""}${
    m.firstWork ? " (when it reached our node wasn't recorded)" : ""}`;
}

/** A marker label's alignment: centred on its line, but kept inside the plot near either end (about 26 px of room). */
function labelShift(m: BlockMarker, plotW: number): string {
  const edgePct = (26 / plotW) * 100;
  if (m.edge === "before" || (m.edge === null && m.pct < edgePct)) return "";
  if (m.edge === "after" || m.pct > 100 - edgePct) return "-translate-x-full";
  return "-translate-x-1/2";
}

function splitSegmentAtGaps(
  seg: TimelineSegment,
  zones: TimeZone[],
): Array<{ startNs: number; endNs: number }> {
  const gaps = zones.filter((z) => z.type === "gap");
  if (gaps.length === 0) return [{ startNs: seg.startNs, endNs: seg.endNs }];

  const result: Array<{ startNs: number; endNs: number }> = [];
  let curStart = seg.startNs;

  for (const gap of gaps) {
    if (gap.startNs >= seg.endNs) break;
    if (gap.endNs <= curStart) continue;
    if (curStart < gap.startNs) {
      result.push({ startNs: curStart, endNs: gap.startNs });
    }
    curStart = gap.endNs;
  }
  if (curStart < seg.endNs) {
    result.push({ startNs: curStart, endNs: seg.endNs });
  }
  return result;
}

type ModelInput = Pick<ForkTimelineProps, "notifications" | "canonicalBlockHash" | "prevHashStatus" | "prevHashKind" | "blocks" | "kindHint" | "ends">;

/** The chart's model (rows, segments, axis, colours): shared by the chart and its miniature, so both agree exactly. */
export function forkTimelineModel({ notifications, canonicalBlockHash, prevHashStatus, prevHashKind, blocks, kindHint, ends }: ModelInput) {
  {
    // Convert big-endian block_hash to raw stratum format for comparison
    const canonicalRaw = canonicalBlockHash
      ? reverseHex(canonicalBlockHash).toLowerCase()
      : null;
    const hintOf = (hash: string): ParentKind | undefined =>
      canonicalRaw === null ? kindHint?.[reverseHex(hash).toLowerCase()] : undefined;
    const kindOf = (hash: string): ParentKind | undefined => prevHashKind?.[reverseHex(hash).toLowerCase()] ?? hintOf(hash);
    // no best block to compare with: a parent the caller knows is shown as unknown, of that kind
    const statusOf = (hash: string): LaneStatus | null =>
      prevHashStatusOf(hash, canonicalRaw, prevHashStatus) ?? (hintOf(hash) ? "unknown" : null);
    const parsed = notifications
      .filter((n) => n.pool_name && n.prev_hash && n.timestamp)
      .map((n) => ({
        poolName: n.pool_name!,
        prevHash: n.prev_hash.toLowerCase(),
        timeNs: parseTimestampToNs(n.timestamp),
        invalid: n.invalid === true,
        empty: n.empty === true,
      }))
      .filter((n) => n.timeNs > 0)
      .sort((a, b) => a.timeNs - b.timeNs);

    if (parsed.length === 0) return null;

    // The templates' span; the axis also takes in block arrivals just outside it (lib/forkTimelineAxis.ts). Without
    // blocks the two are the same. A pool's last run ends at the last template, not at the axis' end.
    const endOf = (pool: string, last: number) => {
      const e = ends?.[pool];
      return typeof e === "number" && Number.isFinite(e) && e >= last ? e : null;
    };
    const lastByPool = new Map<string, number>();
    parsed.forEach((p) => lastByPool.set(p.poolName, p.timeNs));
    const poolEnds = [...lastByPool].map(([pool, last]) => endOf(pool, last)).filter((e): e is number => e !== null);
    const dataMaxTime = Math.max(parsed[parsed.length - 1].timeNs, ...poolEnds);
    // each block at its arrival where recorded, else when our feeds first built on it (lib/forkTimelineAxis.ts markerBlocks)
    const seenBlocks = markerBlocks(blocks);
    const { minNs: minTime, maxNs: maxTime } = axisDomain(parsed[0].timeNs, dataMaxTime, seenBlocks);
    const duration = maxTime - minTime;

    // Assign colors by frequency. The block before (a pool going back to it) is listed last and doesn't change the
    // order of the parents at the height, nor so the order of the pools.
    const hashCounts = new Map<string, number>();
    parsed.forEach((p) =>
      hashCounts.set(p.prevHash, (hashCounts.get(p.prevHash) || 0) + 1),
    );
    const isPrevious = (h: string) => statusOf(h) === "previous";
    const sortedHashes = [...hashCounts.entries()]
      .sort((a, b) => Number(isPrevious(a[0])) - Number(isPrevious(b[0])) || b[1] - a[1])
      .map((e) => e[0]);
    const colorMap = new Map<string, string>();
    sortedHashes.forEach((h, i) =>
      colorMap.set(h, PREV_HASH_COLORS[i % PREV_HASH_COLORS.length]),
    );

    // Build raw per-pool timelines and collect transition events
    const poolMap = new Map<
      string,
      Array<{ timeNs: number; prevHash: string; invalid: boolean; empty: boolean }>
    >();
    parsed.forEach((p) => {
      if (!poolMap.has(p.poolName)) poolMap.set(p.poolName, []);
      poolMap.get(p.poolName)!.push({ timeNs: p.timeNs, prevHash: p.prevHash, invalid: p.invalid, empty: p.empty });
    });

    const transitionTimes: number[] = [];
    const rawTimelines: Array<{
      poolName: string;
      segments: TimelineSegment[];
      firstNs: number;
      switched: boolean;
      initialHash: string;
    }> = [];

    poolMap.forEach((entries, poolName) => {
      const segments: TimelineSegment[] = [];
      let currentHash = entries[0].prevHash;
      let currentInvalid = entries[0].invalid;
      let currentEmpty = entries[0].empty;
      let segStart = entries[0].timeNs;
      let switched = false;
      let lastParent = currentHash;
      if (currentInvalid || currentEmpty) transitionTimes.push(segStart);

      for (let i = 1; i < entries.length; i++) {
        if (entries[i].prevHash !== currentHash || entries[i].invalid !== currentInvalid || entries[i].empty !== currentEmpty) {
          segments.push({
            startNs: segStart,
            endNs: entries[i].timeNs,
            prevHash: currentHash,
            invalid: currentInvalid,
            empty: currentEmpty,
          });
          // a change of parent, invalid work or an empty template starting or ending: what the axis should show
          transitionTimes.push(entries[i].timeNs);
          // a switch between the height's parents: going back to the block before in between isn't one, so it
          // doesn't move the pool in the order
          if (!isPrevious(entries[i].prevHash)) {
            if (entries[i].prevHash !== lastParent) switched = true;
            lastParent = entries[i].prevHash;
          }
          currentHash = entries[i].prevHash;
          currentInvalid = entries[i].invalid;
          currentEmpty = entries[i].empty;
          segStart = entries[i].timeNs;
        }
      }
      const end = endOf(poolName, entries[entries.length - 1].timeNs);
      if (end !== null) transitionTimes.push(end);
      segments.push({ startNs: segStart, endNs: end ?? (ends ? entries[entries.length - 1].timeNs : dataMaxTime), prevHash: currentHash, invalid: currentInvalid, empty: currentEmpty });

      rawTimelines.push({
        poolName,
        segments,
        firstNs: entries[0].timeNs,
        switched,
        initialHash: entries[0].prevHash,
      });
    });

    // Sort pools: majority hash first, non-switchers first, then by first appearance
    rawTimelines.sort((a, b) => {
      const aIdx = sortedHashes.indexOf(a.initialHash);
      const bIdx = sortedHashes.indexOf(b.initialHash);
      if (aIdx !== bIdx) return aIdx - bIdx;
      if (a.switched !== b.switched) return a.switched ? 1 : -1;
      return a.firstNs - b.firstNs;
    });

    // Build time zones for compression
    // a block's line is an event too: a quiet stretch is never compressed over it
    for (const b of seenBlocks) {
      const t = b.seen_ms! * 1_000_000;
      if (t >= minTime && t <= maxTime) transitionTimes.push(t);
    }
    const timeZones = buildTimeZones(transitionTimes, minTime, maxTime);
    const compressed = timeZones !== null;

    const toVisual = (ns: number) =>
      mapTimeToVisual(ns, timeZones, minTime, duration);

    // Build visual pool timelines with segments split at gaps
    const poolTimelines: PoolTimelineData[] = rawTimelines.map((raw) => {
      const visualSegments: VisualSegment[] = [];

      for (const seg of raw.segments) {
        const subSegs = compressed
          ? splitSegmentAtGaps(seg, timeZones!)
          : [{ startNs: seg.startNs, endNs: seg.endNs }];

        for (const sub of subSegs) {
          const leftPct = toVisual(sub.startNs);
          const rightPct = toVisual(sub.endNs);
          const widthPct = Math.max(rightPct - leftPct, 0.3);
          const relStart = formatRelativeTime(sub.startNs - minTime);
          const relEnd = formatRelativeTime(sub.endNs - minTime);
          const status = statusOf(seg.prevHash);
          // hatched: not the best parent (the block before isn't a parent at the height: not hatched)
          const isStale = status !== null && status !== "canonical" && status !== "previous";
          const label = labelOf(status, kindOf(seg.prevHash));
          const staleLabel = label !== null ? ` (${label})` : "";
          visualSegments.push({
            leftPct,
            widthPct,
            prevHash: seg.prevHash,
            isStale,
            invalid: seg.invalid === true,
            // invalid work (always empty) keeps its full rose bar
            empty: seg.empty === true && !seg.invalid,
            tooltip: `${raw.poolName}${staleLabel}${seg.invalid ? " · invalid work" : ""}${seg.empty ? " · empty template" : ""}\n${formatPrevBlockHash(seg.prevHash)}\n${relStart} → ${relEnd}`,
          });
        }
      }

      return {
        poolName: raw.poolName,
        visualSegments,
        initialHash: raw.initialHash,
        switched: raw.switched,
        firstNs: raw.firstNs,
      };
    });

    // Gap indicators for rendering
    const gapIndicators = compressed
      ? timeZones!
          .filter((z) => z.type === "gap")
          .map((z) => ({
            leftPct: z.visualStartPct,
            widthPct: z.visualEndPct - z.visualStartPct,
            fromLabel: formatRelativeTime(z.startNs - minTime),
            toLabel: formatRelativeTime(z.endNs - minTime),
          }))
      : [];

    // Build time axis ticks
    const ticks: Array<{ pct: number; label: string }> = [];
    if (duration > 0) {
      if (compressed && timeZones) {
        // Place ticks at zone boundaries
        for (const zone of timeZones) {
          if (zone.type === "active") {
            ticks.push({
              pct: zone.visualStartPct,
              label: formatRelativeTime(zone.startNs - minTime),
            });
            // Add intermediate ticks for wider zones
            const zonePctWidth = zone.visualEndPct - zone.visualStartPct;
            const zoneDurSec =
              (zone.endNs - zone.startNs) / 1_000_000_000;
            if (zonePctWidth > 15 && zoneDurSec > 2) {
              let interval: number;
              if (zoneDurSec <= 5) interval = 1;
              else if (zoneDurSec <= 15) interval = 2;
              else if (zoneDurSec <= 30) interval = 5;
              else interval = 10;
              for (
                let s = interval;
                s < zoneDurSec;
                s += interval
              ) {
                const ns = zone.startNs + s * 1_000_000_000;
                ticks.push({
                  pct: toVisual(ns),
                  label: formatRelativeTime(ns - minTime),
                });
              }
            }
          }
        }
        // End tick
        const lastZone = timeZones[timeZones.length - 1];
        ticks.push({
          pct: lastZone.visualEndPct,
          label: formatRelativeTime(maxTime - minTime),
        });
      } else {
        const durationSec = duration / 1_000_000_000;
        let interval: number;
        if (durationSec <= 5) interval = 1;
        else if (durationSec <= 15) interval = 2;
        else if (durationSec <= 30) interval = 5;
        else if (durationSec <= 120) interval = 15;
        else if (durationSec <= 300) interval = 30;
        else interval = 60;
        for (let s = 0; s <= durationSec + 0.001; s += interval) {
          const pct = (s / durationSec) * 100;
          if (pct <= 100.5) {
            ticks.push({ pct: Math.min(pct, 100), label: `${s}s` });
          }
        }
      }
    }

    // A label equal to the one before it says nothing: keep the first
    for (let i = ticks.length - 1; i > 0; i--) if (ticks[i].label === ticks[i - 1].label) ticks.splice(i, 1);

    // Grid lines: from ticks + gap boundaries
    const gridLines: number[] = ticks.map((t) => t.pct);
    if (compressed && timeZones) {
      for (const z of timeZones) {
        if (z.type === "active") {
          gridLines.push(z.visualStartPct);
          gridLines.push(z.visualEndPct);
        }
      }
    }

    // Build a map of hash → canonical/stale status
    const hashStatus = new Map<string, LaneStatus | null>();
    sortedHashes.forEach((h) => hashStatus.set(h, statusOf(h)));

    // Semantic colors wherever a status is known (the canonical side, or a kind the caller knows)
    sortedHashes.forEach((h) => {
      const status = hashStatus.get(h);
      if (status === "canonical") colorMap.set(h, CANONICAL_HASH_COLOR);
      else if (status === "stale") colorMap.set(h, STALE_HASH_COLOR);
      else if (status === "previous") colorMap.set(h, PREVIOUS_HASH_COLOR);
      else if (status === "unknown") {
        const kind = kindOf(h);
        colorMap.set(h, kind ? KIND_COLOR[kind] : UNKNOWN_HASH_COLOR);
      }
    });

    return {
      poolTimelines,
      sortedHashes,
      colorMap,
      hashStatus,
      hashKind: new Map(sortedHashes.map((h) => [h, kindOf(h)] as const)),
      ticks,
      gridLines: [...new Set(gridLines)],
      gapIndicators,
      duration,
      compressed,
      timeZones,
      minTime,
      maxTime,
      seenBlocks,
      anyEmpty: poolTimelines.some((p) => p.visualSegments.some((v) => v.empty)),
    };
  }
}

export type ForkTimelineModel = NonNullable<ReturnType<typeof forkTimelineModel>>;

export default function ForkTimeline({
  notifications, canonicalBlockHash, prevHashStatus, prevHashKind, blocks, invalidCoinbasePools, kindHint, title = "Fork",
  ends, embedded = false,
}: ForkTimelineProps) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const computed = useMemo(
    () => forkTimelineModel({ notifications, canonicalBlockHash, prevHashStatus, prevHashKind, blocks, kindHint, ends }),
    [notifications, canonicalBlockHash, prevHashStatus, prevHashKind, blocks, kindHint, ends],
  );

  const [sortMode, setSortMode] = useState<"grouped" | "time">("grouped");

  // an empty element rather than null, so the width observer has its element from the first render
  if (!computed || computed.poolTimelines.length === 0) return <div ref={ref} />;

  const {
    poolTimelines,
    sortedHashes,
    colorMap,
    hashStatus,
    hashKind,
    ticks,
    gridLines,
    gapIndicators,
    duration,
    compressed,
    timeZones,
    minTime,
    maxTime,
  } = computed;

  const hasPrevious = sortedHashes.some((h) => hashStatus.get(h) === "previous");
  const displayTimelines =
    sortMode === "time"
      ? [...poolTimelines].sort((a, b) => a.firstNs - b.firstNs)
      : poolTimelines;

  const LABEL_W = width < 480 ? 92 : 140;
  const plotW = Math.max(50, width - LABEL_W);
  // a label is about 50 px wide: closer arrivals alternate rows
  const markers = placeBlockMarkers(computed.seenBlocks, timeZones, minTime, maxTime, (56 / plotW) * 100);
  const invalid = new Set(invalidCoinbasePools ?? []);
  // tick labels at least ~36 px apart, so a narrow (phone) plot doesn't stack them
  const shownTicks: typeof ticks = [];
  for (const t of ticks) {
    const prev = shownTicks[shownTicks.length - 1];
    if (!prev || ((t.pct - prev.pct) / 100) * plotW >= 36) shownTicks.push(t);
  }

  return (
    <div ref={ref} className={embedded ? "" : "mt-2"}>
      {!embedded && (<>
      <div className="flex items-center gap-3 mb-3">
        <div className="text-sm font-semibold">{title}</div>
        <div className="flex items-center gap-1.5 text-[10px]">
          <span className="text-muted-foreground">Sort:</span>
          <div className="flex items-center rounded-md border border-border overflow-hidden">
            <button
              type="button"
              className={`px-2.5 py-0.5 transition-colors ${
                sortMode === "grouped"
                  ? "bg-blue-600 text-white"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
              onClick={() => setSortMode("grouped")}
            >
              By Chain
            </button>
            <button
              type="button"
              className={`px-2.5 py-0.5 transition-colors ${
                sortMode === "time"
                  ? "bg-blue-600 text-white"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
              onClick={() => setSortMode("time")}
            >
              By Time
            </button>
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-col gap-1.5 mb-4">
        {sortedHashes.map((hash) => {
          const status = hashStatus.get(hash);
          return (
            <div key={hash} className="flex items-center gap-2 min-w-0">
              <div
                className="w-3 h-3 rounded-xs shrink-0 relative"
                style={{ backgroundColor: colorMap.get(hash) }}
              >
                {(status === "stale" || status === "unknown") && (
                  <div
                    className="absolute inset-0 rounded-xs"
                    style={{
                      background:
                        "repeating-linear-gradient(-45deg, transparent, transparent 1.5px, rgba(0,0,0,0.45) 1.5px, rgba(0,0,0,0.45) 3px)",
                    }}
                  />
                )}
              </div>
              {status === "canonical" && (
                <span className="text-[9px] font-semibold text-emerald-400 shrink-0">
                  Active chain
                </span>
              )}
              {status === "stale" && (
                <span className="text-[9px] font-semibold text-red-400 shrink-0">
                  Stale
                </span>
              )}
              {status === "unknown" && (
                <span className={`text-[9px] font-semibold shrink-0 ${KIND_TEXT[hashKind.get(hash) ?? "undetermined"]}`}>
                  {KIND_LABEL[hashKind.get(hash) ?? "undetermined"]}
                </span>
              )}
              {status === "previous" && (
                <span className="text-[9px] font-semibold text-muted-foreground shrink-0">
                  The block before
                </span>
              )}
              <span className="text-[10px] opacity-75 font-mono break-all">
                {formatPrevBlockHash(hash)}
              </span>
            </div>
          );
        })}
        {computed.anyEmpty && <EmptyKey />}
        {compressed && (
          <span className="text-[9px] text-muted-foreground/50 italic">
            (quiet periods compressed)
          </span>
        )}
        {markers.length > 0 && (
          <span className="text-[9px] text-muted-foreground/60">
            {markers.some((m) => !m.firstWork) && "│ when a block reached our node"}
            {markers.some((m) => !m.firstWork) && markers.some((m) => m.firstWork) && " · "}
            {markers.some((m) => m.firstWork) && "┆ when our feeds first built on a block (its arrival wasn't recorded)"}
            {markers.some((m) => !m.best) ? <> · <span className="text-[#1550a4] dark:text-blue-400">stale</span></> : null}
          </span>
        )}
      </div>
      </>)}

      {/* Time axis */}
      {duration > 0 && ticks.length > 0 && (
        <div
          className="relative h-4 mb-0.5"
          style={{ marginLeft: `${LABEL_W}px` }}
        >
          {shownTicks.map((t, i) => (
            <span
              key={i}
              className="absolute text-[9px] text-muted-foreground/60 -translate-x-1/2 select-none"
              style={{ left: `${t.pct}%` }}
            >
              {t.label}
            </span>
          ))}
          {/* Gap break indicators on the axis */}
          {gapIndicators.map((g, i) => (
            <div
              key={`gap-axis-${i}`}
              className="absolute top-0 h-full flex items-center justify-center"
              style={{
                left: `${g.leftPct}%`,
                width: `${g.widthPct}%`,
              }}
              title={`${g.fromLabel} → ${g.toLabel} (compressed)`}
            >
              <span className="text-[9px] text-muted-foreground/40 select-none">
                ⋯
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Block arrivals: the height above each marker line, two rows so blocks seen moments apart stay legible */}
      {markers.length > 0 && (
        <div className="relative h-6" style={{ marginLeft: `${LABEL_W}px` }}>
          {markers.map((m) => (
            <span
              key={m.hash}
              className={`absolute font-mono text-[9px] leading-none whitespace-nowrap select-none ${
                m.best ? "text-foreground/60" : "text-[#1550a4] dark:text-blue-400"
              } ${labelShift(m, plotW)}`}
              style={{ left: `${m.pct}%`, top: m.row === 1 ? 0 : 12 }}
              title={markerTitle(m)}
            >
              {m.edge === "before" ? `‹ ${fmtHeight(m.height)}` : m.edge === "after" ? `${fmtHeight(m.height)} ›` : fmtHeight(m.height)}
            </span>
          ))}
        </div>
      )}

      {/* Pool rows */}
      <div className="relative">
        {markers.some((m) => m.edge === null) && (
          <div className="absolute inset-y-0 right-0 pointer-events-none z-10" style={{ left: `${LABEL_W}px` }} aria-hidden>
            {markers.filter((m) => m.edge === null).map((m) => (
              <div
                key={m.hash}
                className={`absolute inset-y-0 w-0 border-l ${m.firstWork ? "border-dashed" : ""} ${m.best ? "border-foreground/60" : "border-[#1550a4] dark:border-blue-400"}`}
                style={{ left: `${m.pct}%` }}
              />
            ))}
          </div>
        )}
        {displayTimelines.map((pool) => {
          const bad = invalid.has(pool.poolName);
          return (
            <div key={pool.poolName} className="flex items-center h-[22px] group">
                <div
                  className={`shrink-0 text-[11px] truncate text-right pr-2.5 ${bad ? "text-rose-500" : "text-muted-foreground"}`}
                  style={{ width: `${LABEL_W}px` }}
                  title={bad ? `${pool.poolName}: invalid coinbase at this height` : pool.poolName}
                >
                  {bad ? "✗ " : ""}{pool.poolName}
                </div>

                <div className="flex-1 h-[14px] rounded-[3px] bg-muted/30 relative overflow-hidden">
                  {/* Grid lines */}
                  {gridLines.map((pct, i) => (
                    <div
                      key={i}
                      className="absolute top-0 h-full w-px bg-border/20"
                      style={{ left: `${pct}%` }}
                    />
                  ))}

                  {/* Gap hatching */}
                  {gapIndicators.map((g, i) => (
                    <div
                      key={`gap-${i}`}
                      className="absolute top-0 h-full"
                      style={{
                        left: `${g.leftPct}%`,
                        width: `${g.widthPct}%`,
                        background:
                          "repeating-linear-gradient(-45deg, transparent, transparent 2px, rgba(128,128,128,0.13) 2px, rgba(128,128,128,0.13) 4px)",
                      }}
                    />
                  ))}

                  {/* Colored segments */}
                  {/* an empty template: a thin bar (hatching keeps its meaning: not the best parent) */}
                  {pool.visualSegments.map((vs, si) => (
                    <div
                      key={si}
                      className={`absolute hover:opacity-100 ${vs.empty ? "inset-y-1" : "inset-y-0"}`}
                      style={{
                        left: `${vs.leftPct}%`,
                        width: `${Math.max(vs.widthPct, 0.3)}%`,
                        backgroundColor: vs.invalid ? INVALID_COLOR : colorMap.get(vs.prevHash) || "#666",
                        opacity: 0.82,
                      }}
                      title={vs.tooltip}
                    >
                      {vs.isStale && (
                        <div
                          className="absolute inset-0"
                          style={{
                            background:
                              "repeating-linear-gradient(-45deg, transparent, transparent 2px, rgba(0,0,0,0.3) 2px, rgba(0,0,0,0.3) 4px)",
                          }}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
          );
        })}
      </div>

      {/* Inside a Forks row the chart has no legend: what the marks only these runs carry mean */}
      {embedded && (computed.anyEmpty || hasPrevious) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1" style={{ marginLeft: `${LABEL_W}px` }}>
          {computed.anyEmpty && <EmptyKey />}
          {hasPrevious && (
            <span className="flex items-center gap-1.5 text-[9px] text-muted-foreground">
              <span className="inline-block h-2.5 w-3 rounded-xs" style={{ backgroundColor: PREVIOUS_HASH_COLOR, opacity: 0.82 }} aria-hidden />
              work on the block before (height − 2)
            </span>
          )}
        </div>
      )}

      {/* Duration label */}
      {!embedded && duration > 0 && (
        <div
          className="text-[10px] text-muted-foreground/50 mt-2"
          style={{ marginLeft: `${LABEL_W}px` }}
        >
          Total span: {formatRelativeTime(duration)}
        </div>
      )}
    </div>
  );
}

/** The key for an empty template's thin bar. */
function EmptyKey() {
  return (
    <span className="flex items-center gap-1.5 text-[9px] text-muted-foreground">
      <span className="relative inline-block h-3.5 w-3 rounded-xs bg-muted/30" aria-hidden>
        <span className="absolute inset-x-0 inset-y-1 bg-muted-foreground/80" />
      </span>
      thin: an empty template (no transactions)
    </span>
  );
}

/**
 * The chart in miniature, for a closed Forks row: one 4 px line per pool, in the chart's own order, on its own axis,
 * with no names, and the blocks' lines unlabelled (opening the row shows the chart itself). The axis ticks stay, so time still reads.
 */
export function MiniForkTimeline(props: ModelInput) {
  const { notifications, canonicalBlockHash, prevHashStatus, prevHashKind, blocks, kindHint, ends } = props;
  const m = useMemo(
    () => forkTimelineModel({ notifications, canonicalBlockHash, prevHashStatus, prevHashKind, blocks, kindHint, ends }),
    [notifications, canonicalBlockHash, prevHashStatus, prevHashKind, blocks, kindHint, ends],
  );
  if (!m || m.poolTimelines.length === 0) return null;
  const shown: typeof m.ticks = [];
  for (const t of m.ticks) {
    const prev = shown[shown.length - 1];
    if (!prev || t.pct - prev.pct >= 9) shown.push(t);
  }
  // the blocks' lines, unlabelled (the open chart names them)
  const lines = placeBlockMarkers(m.seenBlocks, m.timeZones, m.minTime, m.maxTime, 0).filter((b) => b.edge === null);
  return (
    <div aria-hidden className="relative">
      {lines.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10" style={{ bottom: "1.25rem" }}>
          {lines.map((b) => (
            <div key={b.hash} className={`absolute inset-y-0 w-0 border-l ${b.firstWork ? "border-dashed" : ""} ${b.best ? "border-foreground/60" : "border-[#1550a4] dark:border-blue-400"}`}
              style={{ left: `${b.pct}%` }} />
          ))}
        </div>
      )}
      {m.poolTimelines.map((pool) => (
        <div key={pool.poolName} className="relative mb-0.5 h-1 overflow-hidden bg-muted/30">
          {pool.visualSegments.map((vs, i) => (
            <div key={i} className="absolute inset-y-0"
              style={{ left: `${vs.leftPct}%`, width: `${Math.max(vs.widthPct, 0.3)}%`,
                backgroundColor: vs.invalid ? INVALID_COLOR : m.colorMap.get(vs.prevHash) || "#666" }} />
          ))}
          {m.gapIndicators.map((g, i) => (
            <div key={`g${i}`} className="absolute inset-y-0 bg-background" style={{ left: `${g.leftPct}%`, width: `${g.widthPct}%` }} />
          ))}
        </div>
      ))}
      <div className="relative mt-1 h-3.5 text-[9px] text-muted-foreground/70">
        {shown.map((t, i) => (
          <span key={i} className={`absolute whitespace-nowrap ${i === 0 ? "" : i === shown.length - 1 && t.pct > 92 ? "-translate-x-full" : "-translate-x-1/2"}`}
            style={{ left: `${t.pct}%` }}>{t.label}</span>
        ))}
      </div>
    </div>
  );
}
