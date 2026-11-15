"use client";

import React, { useMemo } from "react";
import * as d3 from "d3";
import type { SettingsOf, VisualProps } from "../framework/types";
import { useTemplates } from "../framework/data";
import { poolColor } from "../framework/poolColors";
import { useElementWidth } from "../framework/useElementWidth";
import { VisualMessage } from "../framework/VisualFrame";
import { clockGroups, poolClocks } from "./selectors";
import type { poolClocksSettings } from "./settings";

type Settings = SettingsOf<typeof poolClocksSettings>;

const ROW = 26;
const MARGIN = { top: 28, right: 72, bottom: 34, left: 150 };

function fmtOffset(s: number): string {
  const sign = s > 0 ? "+" : s < 0 ? "−" : "±";
  const a = Math.abs(s);
  return `${sign}${a >= 10 ? a.toFixed(0) : a.toFixed(1)} s`;
}

export default function PoolClocks({ settings, instanceKey }: VisualProps<typeof poolClocksSettings>) {
  const s = settings as Settings;
  const { templates, loading } = useTemplates({ heights: s.heights });
  const { ref, width } = useElementWidth<HTMLDivElement>();

  const result = useMemo(() => poolClocks(templates, s.reference, s.sortBy), [templates, s.reference, s.sortBy]);
  const groups = useMemo(() => clockGroups(result.pools, s.groupTolerance), [result.pools, s.groupTolerance]);
  const groupOf = useMemo(() => {
    const m = new Map<string, number>();
    groups.forEach((g, i) => g.forEach((p) => m.set(p, i)));
    return m;
  }, [groups]);

  if (loading && templates.length === 0) return <VisualMessage>Loading templates…</VisualMessage>;
  if (result.pools.length === 0) {
    return (
      <VisualMessage>
        No pool pushed a timestamp in the {s.heights === 1 ? "current height" : `last ${s.heights} heights`} yet
        {result.withoutClock.length > 0 ? ` (checked ${result.withoutClock.length}: ${result.withoutClock.join(", ")})` : ""}.
      </VisualMessage>
    );
  }

  const innerW = Math.max(200, width - MARGIN.left - MARGIN.right);
  const height = MARGIN.top + MARGIN.bottom + result.pools.length * ROW;
  const lo = Math.min(0, ...result.pools.map((p) => p.min));
  const hi = Math.max(0, ...result.pools.map((p) => p.max));
  const pad = Math.max(1, (hi - lo) * 0.08);
  const x = d3.scaleLinear().domain([lo - pad, hi + pad]).range([0, innerW]).nice();
  const y = d3
    .scaleBand<string>()
    .domain(result.pools.map((p) => p.pool))
    .range([0, result.pools.length * ROW])
    .padding(0.25);
  const refLabel = s.reference === "ntime" ? "header ntime" : "our receive time";

  return (
    <div ref={ref} className="w-full">
      <svg width={width} height={height} role="img" aria-labelledby={`${instanceKey}-desc`} className="text-foreground">
        <desc id={`${instanceKey}-desc`}>
          Offset of each pool&apos;s coinbase timestamp from {refLabel}, per pool. Dots are templates, the bar spans min to max,
          the tick is the median.
        </desc>
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {x.ticks(8).map((t) => (
            <g key={t} transform={`translate(${x(t)},0)`}>
              <line y1={-6} y2={result.pools.length * ROW} stroke="currentColor" strokeOpacity={t === 0 ? 0.6 : 0.12} strokeDasharray={t === 0 ? "4 3" : undefined} />
              <text y={result.pools.length * ROW + 16} textAnchor="middle" fontSize={10} fill="currentColor" opacity={0.7}>
                {t === 0 ? "0" : `${t > 0 ? "+" : "−"}${Math.abs(t)} s`}
              </text>
            </g>
          ))}
          <text x={x(0)} y={-12} textAnchor="middle" fontSize={10} fill="currentColor" opacity={0.7}>
            = {refLabel}
          </text>
          <text x={innerW} y={result.pools.length * ROW + 30} textAnchor="end" fontSize={10} fill="currentColor" opacity={0.6}>
            pool clock ahead →
          </text>
          <text x={0} y={result.pools.length * ROW + 30} fontSize={10} fill="currentColor" opacity={0.6}>
            ← pool clock behind
          </text>
          {result.pools.map((p) => {
            const cy = (y(p.pool) ?? 0) + y.bandwidth() / 2;
            const color = poolColor(p.pool);
            const g = groupOf.get(p.pool);
            return (
              <g key={p.pool}>
                <title>
                  {`${p.pool}: median ${fmtOffset(p.median)} (min ${fmtOffset(p.min)}, max ${fmtOffset(p.max)}), ${p.samples.length} templates, ` +
                    `${Math.round(p.coverage * 100)}% carried a time${g !== undefined ? `; similar offset to ${groups[g].filter((n) => n !== p.pool).join(", ")}` : ""}`}
                </title>
                {g !== undefined && (
                  <rect x={-MARGIN.left + 4} y={y(p.pool)} width={4} height={y.bandwidth()} fill={d3.schemeTableau10[g % 10]} rx={1} />
                )}
                <text x={-10} y={cy} dy="0.35em" textAnchor="end" fontSize={12} fill="currentColor">
                  {p.pool.length > 20 ? p.pool.slice(0, 19) + "…" : p.pool}
                </text>
                <line x1={x(p.min)} x2={x(p.max)} y1={cy} y2={cy} stroke={color} strokeOpacity={0.35} strokeWidth={y.bandwidth() * 0.5} strokeLinecap="round" />
                {s.showSamples &&
                  p.samples.slice(-400).map((smp, i) => (
                    <circle key={i} cx={x(smp.offset)} cy={cy + ((i % 5) - 2) * 1.6} r={2} fill={color} fillOpacity={0.55} />
                  ))}
                <line x1={x(p.median)} x2={x(p.median)} y1={cy - y.bandwidth() / 2} y2={cy + y.bandwidth() / 2} stroke={color} strokeWidth={3} />
                <text x={innerW + 8} y={cy} dy="0.35em" fontSize={11} fill="currentColor" className="tabular-nums">
                  {fmtOffset(p.median)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      {groups.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Similar clocks (medians within {s.groupTolerance} s), marked on the left:{" "}
          {groups.map((g) => g.join(" · ")).join("; ")}. A shared offset can point to shared pool infrastructure, or just to
          the same software defaults.
        </p>
      )}
      {result.withoutClock.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          No timestamp in the coinbase ({result.withoutClock.length}): {result.withoutClock.join(", ")}.
        </p>
      )}
    </div>
  );
}
