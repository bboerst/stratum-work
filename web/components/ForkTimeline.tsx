"use client";

import React, { useMemo } from "react";
import { formatPrevBlockHash, reverseHex } from "@/utils/formatters";

interface MiningNotification {
  pool_name?: string | null;
  timestamp: string;
  prev_hash: string;
}

interface ForkTimelineProps {
  notifications: MiningNotification[];
  canonicalBlockHash?: string;
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
const STALE_HASH_COLOR = "#1550a4"; // slate-500 (muted/disabled look)

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

interface TimeZone {
  type: "active" | "gap";
  startNs: number;
  endNs: number;
  visualStartPct: number;
  visualEndPct: number;
}

interface TimelineSegment {
  startNs: number;
  endNs: number;
  prevHash: string;
}

interface VisualSegment {
  leftPct: number;
  widthPct: number;
  prevHash: string;
  tooltip: string;
  isStale: boolean;
}

interface PoolTimelineData {
  poolName: string;
  visualSegments: VisualSegment[];
  initialHash: string;
  switched: boolean;
  firstNs: number;
}

function formatRelativeTime(ns: number): string {
  const sec = ns / 1_000_000_000;
  if (sec < 0.001) return "0s";
  if (sec < 1) return `${(sec * 1000).toFixed(0)}ms`;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${(sec / 60).toFixed(1)}m`;
}

function buildTimeZones(
  transitionTimesNs: number[],
  globalMinNs: number,
  globalMaxNs: number,
): TimeZone[] | null {
  const duration = globalMaxNs - globalMinNs;
  if (duration <= 0) return null;

  const durationSec = duration / 1_000_000_000;
  if (durationSec < 60) return null;
  if (transitionTimesNs.length === 0) return null;

  const PADDING_NS = Math.min(5_000_000_000, duration * 0.10);
  const GAP_THRESHOLD_NS = Math.max(10_000_000_000, duration * 0.15);
  const GAP_VISUAL_PCT = 2.5;

  const eventPoints = [globalMinNs, ...transitionTimesNs, globalMaxNs];
  const rawZones = eventPoints.map((t) => ({
    start: Math.max(globalMinNs, t - PADDING_NS),
    end: Math.min(globalMaxNs, t + PADDING_NS),
  }));

  rawZones.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [{ ...rawZones[0] }];
  for (let i = 1; i < rawZones.length; i++) {
    const last = merged[merged.length - 1];
    if (rawZones[i].start <= last.end + GAP_THRESHOLD_NS) {
      last.end = Math.max(last.end, rawZones[i].end);
    } else {
      merged.push({ ...rawZones[i] });
    }
  }

  if (merged.length <= 1) return null;

  const numGaps = merged.length - 1;
  const totalGapPct = Math.min(numGaps * GAP_VISUAL_PCT, 12);
  const perGapPct = totalGapPct / numGaps;
  const activePct = 100 - totalGapPct;
  const totalActiveDuration = merged.reduce((s, z) => s + (z.end - z.start), 0);
  if (totalActiveDuration <= 0) return null;

  const zones: TimeZone[] = [];
  let pos = 0;
  for (let i = 0; i < merged.length; i++) {
    const z = merged[i];
    const zPct = ((z.end - z.start) / totalActiveDuration) * activePct;
    zones.push({
      type: "active",
      startNs: z.start,
      endNs: z.end,
      visualStartPct: pos,
      visualEndPct: pos + zPct,
    });
    pos += zPct;
    if (i < merged.length - 1) {
      zones.push({
        type: "gap",
        startNs: z.end,
        endNs: merged[i + 1].start,
        visualStartPct: pos,
        visualEndPct: pos + perGapPct,
      });
      pos += perGapPct;
    }
  }
  return zones;
}

function mapTimeToVisual(
  timeNs: number,
  zones: TimeZone[] | null,
  globalMinNs: number,
  durationNs: number,
): number {
  if (!zones || durationNs <= 0) {
    return ((timeNs - globalMinNs) / durationNs) * 100;
  }
  for (const zone of zones) {
    if (timeNs <= zone.endNs) {
      if (timeNs < zone.startNs) return zone.visualStartPct;
      const span = zone.endNs - zone.startNs;
      if (span <= 0) return zone.visualStartPct;
      const frac = (timeNs - zone.startNs) / span;
      return zone.visualStartPct + frac * (zone.visualEndPct - zone.visualStartPct);
    }
  }
  return zones[zones.length - 1].visualEndPct;
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

export default function ForkTimeline({ notifications, canonicalBlockHash }: ForkTimelineProps) {
  const computed = useMemo(() => {
    // Convert big-endian block_hash to raw stratum format for comparison
    const canonicalRaw = canonicalBlockHash
      ? reverseHex(canonicalBlockHash).toLowerCase()
      : null;
    const parsed = notifications
      .filter((n) => n.pool_name && n.prev_hash && n.timestamp)
      .map((n) => ({
        poolName: n.pool_name!,
        prevHash: n.prev_hash.toLowerCase(),
        timeNs: parseTimestampToNs(n.timestamp),
      }))
      .filter((n) => n.timeNs > 0)
      .sort((a, b) => a.timeNs - b.timeNs);

    if (parsed.length === 0) return null;

    const minTime = parsed[0].timeNs;
    const maxTime = parsed[parsed.length - 1].timeNs;
    const duration = maxTime - minTime;

    // Assign colors by frequency
    const hashCounts = new Map<string, number>();
    parsed.forEach((p) =>
      hashCounts.set(p.prevHash, (hashCounts.get(p.prevHash) || 0) + 1),
    );
    const sortedHashes = [...hashCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map((e) => e[0]);
    const colorMap = new Map<string, string>();
    sortedHashes.forEach((h, i) =>
      colorMap.set(h, PREV_HASH_COLORS[i % PREV_HASH_COLORS.length]),
    );

    // Build raw per-pool timelines and collect transition events
    const poolMap = new Map<
      string,
      Array<{ timeNs: number; prevHash: string }>
    >();
    parsed.forEach((p) => {
      if (!poolMap.has(p.poolName)) poolMap.set(p.poolName, []);
      poolMap.get(p.poolName)!.push({ timeNs: p.timeNs, prevHash: p.prevHash });
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
      let segStart = entries[0].timeNs;
      let switched = false;

      for (let i = 1; i < entries.length; i++) {
        if (entries[i].prevHash !== currentHash) {
          segments.push({
            startNs: segStart,
            endNs: entries[i].timeNs,
            prevHash: currentHash,
          });
          transitionTimes.push(entries[i].timeNs);
          currentHash = entries[i].prevHash;
          segStart = entries[i].timeNs;
          switched = true;
        }
      }
      segments.push({ startNs: segStart, endNs: maxTime, prevHash: currentHash });

      rawTimelines.push({
        poolName,
        segments,
        firstNs: entries[0].timeNs,
        switched,
        initialHash: entries[0].prevHash,
      });
    });

    // Sort pools only by first-seen time (top to bottom = earliest to latest)
    rawTimelines.sort((a, b) => {
      if (a.firstNs !== b.firstNs) return a.firstNs - b.firstNs;
      return a.poolName.localeCompare(b.poolName);
    });

    // Build time zones for compression
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
          const clampedLeftPct = Math.max(0, Math.min(leftPct, 100));
          const rawWidthPct = Math.max(rightPct - leftPct, 0);
          const maxAllowedWidthPct = Math.max(0, 100 - clampedLeftPct);
          const widthPct = Math.min(
            Math.max(rawWidthPct, Math.min(0.3, maxAllowedWidthPct)),
            maxAllowedWidthPct,
          );
          const relStart = formatRelativeTime(sub.startNs - minTime);
          const relEnd = formatRelativeTime(sub.endNs - minTime);
          const isStale = canonicalRaw !== null && seg.prevHash !== canonicalRaw;
          const staleLabel = canonicalRaw !== null ? (isStale ? " (stale)" : " (canonical)") : "";
          visualSegments.push({
            leftPct: clampedLeftPct,
            widthPct,
            prevHash: seg.prevHash,
            isStale,
            tooltip: `${raw.poolName}${staleLabel}\n${formatPrevBlockHash(seg.prevHash)}\n${relStart} → ${relEnd}`,
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
    const hashStatus = new Map<string, "canonical" | "stale" | null>();
    sortedHashes.forEach((h) => {
      if (canonicalRaw === null) {
        hashStatus.set(h, null);
      } else {
        hashStatus.set(h, h === canonicalRaw ? "canonical" : "stale");
      }
    });

    // Force semantic colors when canonical side is known.
    if (canonicalRaw !== null) {
      sortedHashes.forEach((h) => {
        const status = hashStatus.get(h);
        if (status === "canonical") colorMap.set(h, CANONICAL_HASH_COLOR);
        else if (status === "stale") colorMap.set(h, STALE_HASH_COLOR);
      });
    }

    return {
      poolTimelines,
      sortedHashes,
      colorMap,
      hashStatus,
      ticks,
      gridLines: [...new Set(gridLines)],
      gapIndicators,
      duration,
      compressed,
    };
  }, [notifications, canonicalBlockHash]);

  if (!computed || computed.poolTimelines.length === 0) return null;

  const {
    poolTimelines,
    sortedHashes,
    colorMap,
    hashStatus,
    ticks,
    gridLines,
    gapIndicators,
    duration,
    compressed,
  } = computed;

  const LABEL_W = 140;

  return (
    <div className="mt-2 pr-1 pb-1">
      <div className="text-sm font-semibold mb-3">Fork</div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 mb-4">
        {sortedHashes.map((hash) => {
          const status = hashStatus.get(hash);
          return (
            <div key={hash} className="flex items-center gap-2 min-w-0">
              <div
                className="w-3 h-3 rounded-sm flex-shrink-0 relative"
                style={{ backgroundColor: colorMap.get(hash) }}
              >
                {status === "stale" && (
                  <div
                    className="absolute inset-0 rounded-sm"
                    style={{
                      background:
                        "repeating-linear-gradient(-45deg, transparent, transparent 1.5px, rgba(0,0,0,0.45) 1.5px, rgba(0,0,0,0.45) 3px)",
                    }}
                  />
                )}
              </div>
              <span className="text-[10px] opacity-75 font-mono break-all">
                {formatPrevBlockHash(hash)}
              </span>
              {status === "canonical" && (
                <span className="text-[9px] font-semibold text-emerald-400 flex-shrink-0">
                  Canonical
                </span>
              )}
              {status === "stale" && (
                <span className="text-[9px] font-semibold text-red-400 flex-shrink-0">
                  Stale
                </span>
              )}
            </div>
          );
        })}
        {compressed && (
          <span className="text-[9px] text-muted-foreground/50 italic self-center ml-2">
            (quiet periods compressed)
          </span>
        )}
      </div>

      {/* Time axis */}
      {duration > 0 && ticks.length > 0 && (
        <div
          className="relative h-4 mb-0.5"
          style={{ marginLeft: `${LABEL_W}px` }}
        >
          {ticks.map((t, i) => (
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

      {/* Pool rows */}
      <div className="pb-1">
        {poolTimelines.map((pool) => {
          return (
            <React.Fragment key={pool.poolName}>
              <div className="flex items-center h-[22px] group">
                <div
                  className="flex-shrink-0 text-[11px] truncate text-right pr-2.5 text-muted-foreground"
                  style={{ width: `${LABEL_W}px` }}
                  title={pool.poolName}
                >
                  {pool.poolName}
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
                  {pool.visualSegments.map((vs, si) => (
                    <div
                      key={si}
                      className="absolute top-0 h-full hover:opacity-100"
                      style={{
                        left: `${vs.leftPct}%`,
                        width: `${Math.max(vs.widthPct, 0.3)}%`,
                        backgroundColor: colorMap.get(vs.prevHash) || "#666",
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
            </React.Fragment>
          );
        })}
      </div>

      {/* Duration label */}
      {duration > 0 && (
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
