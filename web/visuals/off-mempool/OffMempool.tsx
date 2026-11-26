"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import type { SettingsOf, VisualProps } from "../framework/types";
import { useOffMempool, useOffPositions } from "../framework/data";
import { useElementWidth } from "../framework/useElementWidth";
import { VisualMessage } from "../framework/VisualFrame";
import { formatRuns } from "@/lib/offMempool";
import { NO_DATA_LABEL, epochTicks, nearestPoint, offMempoolLayout, type OffPoint } from "./selectors";
import type { offMempoolSettings } from "./settings";

type Settings = SettingsOf<typeof offMempoolSettings>;

const HEIGHT = 320;
const M = { top: 10, right: 12, bottom: 34, left: 44 };
const STRIP = 4;          // the no-data strip under the plot
const R = 2.5;            // dot radius

const pct = (s: number) => (s === 0 ? "0%" : s < 0.001 ? "<0.1%" : `${(s * 100).toFixed(s < 0.1 ? 1 : 0)}%`);

/**
 * One dot per measured block at its off-mempool share, on a block-height axis with difficulty epochs; blocks with no
 * data as grey marks on a strip below. Dots on a canvas (tens of thousands over 26 epochs), axes in SVG.
 */
export default function OffMempool({ settings, instanceKey }: VisualProps<typeof offMempoolSettings>) {
  const s = settings as Settings;
  const view = useOffMempool(s.range);
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ p: OffPoint; x: number; y: number } | null>(null);
  const [dwell, setDwell] = useState<number | null>(null);   // the hovered block, after a short pause (positions)
  const positions = useOffPositions(hover && dwell === hover.p.height ? dwell : null);

  const layout = useMemo(() => offMempoolLayout(view.rows), [view.rows]);
  const innerW = Math.max(200, width - M.left - M.right);
  const innerH = HEIGHT - M.top - M.bottom - STRIP - 4;
  // the axis starts where the range does, or where the record does if later: no blocks before it have data
  const from = Math.max(view.fromHeight ?? 0, view.recordFrom ?? 0);
  const to = view.tipHeight ?? from;
  const x = useMemo(() => d3.scaleLinear().domain([from - 0.5, to + 0.5]).range([0, innerW]), [from, to, innerW]);
  const y = useMemo(() => d3.scaleLinear().domain([0, 1]).range([innerH, 0]), [innerH]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(innerW * dpr);
    c.height = Math.round(innerH * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerW, innerH);
    ctx.fillStyle = getComputedStyle(c).color;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    for (const p of layout.points) {
      const cx = x(p.height), cy = y(p.share);
      ctx.moveTo(cx + R, cy);
      ctx.arc(cx, cy, R, 0, 2 * Math.PI);
    }
    ctx.fill();
  }, [layout.points, x, y, innerW, innerH]);

  useEffect(() => {
    if (!hover || hover.p.off === 0) return;
    const t = setTimeout(() => setDwell(hover.p.height), 250);
    return () => clearTimeout(t);
  }, [hover]);

  // the measured wrapper is always mounted, so its width is known when the data arrives
  let message: string | null = null;
  if (view.loading && view.rows.length === 0 && !view.error) message = "Loading blocks…";
  else if (view.error) message = view.error;
  else if (view.recordFrom === null) message = "The mempool recorder hasn't recorded a block yet.";
  if (message !== null) return <div ref={ref} className="w-full"><VisualMessage>{message}</VisualMessage></div>;

  const ticks = epochTicks(from, to);
  const stripY = innerH + 4;
  const recordStarts = view.fromHeight !== null && view.recordFrom! > view.fromHeight;
  const hoverRow = hover ? layout.byHeight.get(hover.p.height) : undefined;
  const descId = `${instanceKey}-desc`;

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left, py = e.clientY - box.top;
    const p = nearestPoint(layout.points, x, y, px, py);
    setHover(p ? { p, x: x(p.height), y: y(p.share) } : null);
  };

  return (
    <div ref={ref} className="relative w-full">
      <div className="mb-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-sky-500 align-middle" />block</span>
        <span><span className="mr-1 inline-block h-1 w-3 rounded-sm bg-muted-foreground/40 align-middle" />no data</span>
        {recordStarts && <span>record starts at {view.recordFrom!.toLocaleString("en-US")}</span>}
      </div>
      <div className="relative" style={{ height: HEIGHT }}>
        <canvas ref={canvas} className="absolute text-sky-500" aria-hidden
          style={{ left: M.left, top: M.top, width: innerW, height: innerH }} />
        <svg width={innerW + M.left + M.right} height={HEIGHT} role="img" aria-describedby={descId} className="absolute left-0 top-0">
          <desc id={descId}>
            Off-mempool share of each block from height {from} to {to}: {layout.points.length} measured blocks.
          </desc>
          <g transform={`translate(${M.left},${M.top})`} className="text-muted-foreground">
            {[0, 0.25, 0.5, 0.75, 1].map(v => (
              <g key={v}>
                <line x1={0} x2={innerW} y1={y(v)} y2={y(v)} stroke="currentColor" strokeOpacity={0.15} />
                <text x={-6} y={y(v) + 4} textAnchor="end" fontSize={11} fill="currentColor">{v * 100}%</text>
              </g>
            ))}
            {ticks.map(h => (
              <g key={h}>
                <line x1={x(h - 0.5)} x2={x(h - 0.5)} y1={0} y2={stripY + STRIP} stroke="currentColor" strokeOpacity={0.25} strokeDasharray="2 3" />
                {x(h) > 70 && x(h) < innerW - 70 && (
                  <text x={x(h - 0.5) + 3} y={stripY + STRIP + 16} fontSize={11} fill="currentColor">{h.toLocaleString("en-US")}</text>
                )}
              </g>
            ))}
            <text x={0} y={stripY + STRIP + 16} fontSize={11} fill="currentColor">{from.toLocaleString("en-US")}</text>
            <text x={innerW} y={stripY + STRIP + 16} fontSize={11} fill="currentColor" textAnchor="end">{to.toLocaleString("en-US")}</text>
            {layout.noData.map(n => (
              <rect key={n.from} x={x(n.from - 0.5)} y={stripY} width={Math.max(2, x(n.to + 0.5) - x(n.from - 0.5))} height={STRIP}
                rx={1} fill="currentColor" fillOpacity={0.45}>
                <title>{n.from === n.to ? n.from.toLocaleString("en-US") : `${n.from.toLocaleString("en-US")}–${n.to.toLocaleString("en-US")}`}: {NO_DATA_LABEL[n.state] ?? "no data"}</title>
              </rect>
            ))}
            {hover && <circle cx={hover.x} cy={hover.y} r={R + 2.5} fill="none" stroke="currentColor" strokeWidth={1.5} className="text-foreground" />}
            <rect x={0} y={0} width={innerW} height={innerH} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
          </g>
        </svg>
        {hover && hoverRow && (
          <div className="pointer-events-none absolute z-10 rounded-md border border-border bg-card px-2 py-1.5 text-xs shadow-md"
            style={{ left: Math.min(M.left + hover.x + 12, Math.max(0, width - 230)), top: Math.max(0, M.top + hover.y - 64), width: 220 }}>
            <div className="font-medium">{hover.p.height.toLocaleString("en-US")} · {hover.p.pool}</div>
            <div>{hover.p.off.toLocaleString("en-US")} of {hover.p.txs.toLocaleString("en-US")} never seen ({pct(hover.p.share)})</div>
            {positions && positions.runs.length > 0 && <div className="text-muted-foreground">positions {formatRuns(positions.runs)}</div>}
            <div className="text-muted-foreground">{new Date(hover.p.time_s * 1000).toLocaleString()}</div>
          </div>
        )}
      </div>
    </div>
  );
}
