"use client";

import React, { useMemo } from "react";
import { formatPrevBlockHash } from "@/utils/formatters";

interface MiningNotification {
  pool_name?: string | null;
  timestamp: string;
  prev_hash: string;
}

interface ForkTimelineProps {
  notifications: MiningNotification[];
}

const PREV_HASH_COLORS = [
  "#3b82f6", // blue-500
  "#f59e0b", // amber-500
  "#10b981", // emerald-500
  "#f43f5e", // rose-500
  "#8b5cf6", // violet-500
  "#06b6d4", // cyan-500
];

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
}

interface PoolTimeline {
  poolName: string;
  segments: TimelineSegment[];
  firstNs: number;
  switched: boolean;
}

function formatRelativeTime(ns: number): string {
  const sec = ns / 1_000_000_000;
  if (sec < 0.001) return "0s";
  if (sec < 1) return `${(sec * 1000).toFixed(0)}ms`;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${(sec / 60).toFixed(1)}m`;
}

export default function ForkTimeline({ notifications }: ForkTimelineProps) {
  const { poolTimelines, prevHashColorMap, sortedHashes, timeRange, ticks } = useMemo(() => {
    const parsed = notifications
      .filter((n) => n.pool_name && n.prev_hash && n.timestamp)
      .map((n) => ({
        poolName: n.pool_name!,
        prevHash: n.prev_hash.toLowerCase(),
        timeNs: parseTimestampToNs(n.timestamp),
      }))
      .filter((n) => n.timeNs > 0)
      .sort((a, b) => a.timeNs - b.timeNs);

    if (parsed.length === 0) {
      return {
        poolTimelines: [],
        prevHashColorMap: new Map<string, string>(),
        sortedHashes: [] as string[],
        timeRange: { min: 0, max: 0 },
        ticks: [] as { pct: number; label: string }[],
      };
    }

    const minTime = parsed[0].timeNs;
    const maxTime = parsed[parsed.length - 1].timeNs;
    const duration = maxTime - minTime;

    const hashCounts = new Map<string, number>();
    parsed.forEach((p) => hashCounts.set(p.prevHash, (hashCounts.get(p.prevHash) || 0) + 1));
    const hashes = [...hashCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map((e) => e[0]);

    const colorMap = new Map<string, string>();
    hashes.forEach((h, i) => colorMap.set(h, PREV_HASH_COLORS[i % PREV_HASH_COLORS.length]));

    const poolMap = new Map<string, Array<{ timeNs: number; prevHash: string }>>();
    parsed.forEach((p) => {
      if (!poolMap.has(p.poolName)) poolMap.set(p.poolName, []);
      poolMap.get(p.poolName)!.push({ timeNs: p.timeNs, prevHash: p.prevHash });
    });

    const timelines: PoolTimeline[] = [];
    poolMap.forEach((entries, poolName) => {
      const segments: TimelineSegment[] = [];
      let currentHash = entries[0].prevHash;
      let segStart = entries[0].timeNs;
      let switched = false;

      for (let i = 1; i < entries.length; i++) {
        if (entries[i].prevHash !== currentHash) {
          segments.push({ startNs: segStart, endNs: entries[i].timeNs, prevHash: currentHash });
          currentHash = entries[i].prevHash;
          segStart = entries[i].timeNs;
          switched = true;
        }
      }
      segments.push({ startNs: segStart, endNs: maxTime, prevHash: currentHash });

      timelines.push({ poolName, segments, firstNs: entries[0].timeNs, switched });
    });

    timelines.sort((a, b) => {
      const aInit = a.segments[0]?.prevHash || "";
      const bInit = b.segments[0]?.prevHash || "";
      const aIdx = hashes.indexOf(aInit);
      const bIdx = hashes.indexOf(bInit);
      if (aIdx !== bIdx) return aIdx - bIdx;
      if (a.switched !== b.switched) return a.switched ? 1 : -1;
      return a.firstNs - b.firstNs;
    });

    const tickMarks: { pct: number; label: string }[] = [];
    if (duration > 0) {
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
          tickMarks.push({ pct: Math.min(pct, 100), label: `${s}s` });
        }
      }
    }

    return {
      poolTimelines: timelines,
      prevHashColorMap: colorMap,
      sortedHashes: hashes,
      timeRange: { min: minTime, max: maxTime },
      ticks: tickMarks,
    };
  }, [notifications]);

  if (poolTimelines.length === 0) return null;

  const duration = timeRange.max - timeRange.min;
  const LABEL_W = 140;

  let lastInitialHash = "";

  return (
    <div className="mt-2">
      <div className="text-sm font-semibold mb-3">Fork</div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 mb-4">
        {sortedHashes.map((hash) => (
          <div key={hash} className="flex items-center gap-2 min-w-0">
            <div
              className="w-3 h-3 rounded-sm flex-shrink-0"
              style={{ backgroundColor: prevHashColorMap.get(hash) }}
            />
            <span
              className="text-[10px] opacity-75 font-mono truncate max-w-[340px]"
              title={formatPrevBlockHash(hash)}
            >
              {formatPrevBlockHash(hash)}
            </span>
          </div>
        ))}
      </div>

      {/* Time axis */}
      {duration > 0 && ticks.length > 0 && (
        <div className="relative h-4 mb-0.5" style={{ marginLeft: `${LABEL_W}px` }}>
          {ticks.map((t, i) => (
            <span
              key={i}
              className="absolute text-[9px] text-muted-foreground/60 -translate-x-1/2 select-none"
              style={{ left: `${t.pct}%` }}
            >
              {t.label}
            </span>
          ))}
        </div>
      )}

      {/* Pool rows */}
      <div>
        {poolTimelines.map((pool, idx) => {
          const initHash = pool.segments[0]?.prevHash || "";
          const showDivider = idx > 0 && initHash !== lastInitialHash;
          lastInitialHash = initHash;

          return (
            <React.Fragment key={pool.poolName}>
              {showDivider && (
                <div className="border-t border-border/40 my-1.5" />
              )}
              <div className="flex items-center h-[22px] group">
                {/* Pool name */}
                <div
                  className="flex-shrink-0 text-[11px] truncate text-right pr-2.5 text-muted-foreground"
                  style={{ width: `${LABEL_W}px` }}
                  title={pool.poolName}
                >
                  {pool.poolName}
                </div>

                {/* Timeline track */}
                <div className="flex-1 h-[14px] rounded-[3px] bg-muted/30 relative overflow-hidden">
                  {/* Tick grid lines */}
                  {ticks.map((t, i) => (
                    <div
                      key={i}
                      className="absolute top-0 h-full w-px bg-border/20"
                      style={{ left: `${t.pct}%` }}
                    />
                  ))}

                  {/* Segments */}
                  {duration > 0
                    ? pool.segments.map((seg, si) => {
                        const left = ((seg.startNs - timeRange.min) / duration) * 100;
                        const width = ((seg.endNs - seg.startNs) / duration) * 100;
                        const color = prevHashColorMap.get(seg.prevHash) || "#666";
                        const relStart = formatRelativeTime(seg.startNs - timeRange.min);
                        const relEnd = formatRelativeTime(seg.endNs - timeRange.min);
                        return (
                          <div
                            key={si}
                            className="absolute top-0 h-full transition-opacity hover:opacity-100"
                            style={{
                              left: `${left}%`,
                              width: `${Math.max(width, 0.4)}%`,
                              backgroundColor: color,
                              opacity: 0.82,
                            }}
                            title={`${pool.poolName}\n${formatPrevBlockHash(seg.prevHash)}\n${relStart} → ${relEnd}`}
                          />
                        );
                      })
                    : pool.segments.length > 0 && (
                        <div
                          className="absolute top-0 h-full w-full"
                          style={{
                            backgroundColor: prevHashColorMap.get(pool.segments[0].prevHash) || "#666",
                            opacity: 0.82,
                          }}
                        />
                      )}
                </div>
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {/* Duration label */}
      {duration > 0 && (
        <div className="text-[10px] text-muted-foreground/50 mt-2" style={{ marginLeft: `${LABEL_W}px` }}>
          Total span: {formatRelativeTime(duration)}
        </div>
      )}
    </div>
  );
}
