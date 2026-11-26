"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import type { OffMempoolView } from "../framework/data";
import { useElementWidth } from "../framework/useElementWidth";
import { VisualMessage } from "../framework/VisualFrame";
import { BlockTip, pct, useDwellPositions, viewMessage } from "./shared";
import { jitter, providerRows, type OffPoint } from "./selectors";

const ROW = 26;
const TOP = 20;               // the share axis labels
const R = 2.5;
const LABEL_W = 150;          // provider names, left
const SUM_W = 120;            // its share and block count, right

const blocksLabel = (n: number) => `${n.toLocaleString("en-US")} block${n === 1 ? "" : "s"}`;

/**
 * One row per template provider (grouped as on the home page), a dot per measured block at its off-mempool share,
 * jittered within the row; on the right the provider's share over all its measured blocks. Same encoding for every
 * row; most blocks first. Dots on a canvas, labels and hover in SVG/HTML.
 */
export default function ByProvider({ view, instanceKey }: { view: OffMempoolView; instanceKey: string }) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const rows = useMemo(() => providerRows(view.rows, view.rowProvider, view.providers), [view.rows, view.rowProvider, view.providers]);
  const narrow = width < 560;
  const labelW = narrow ? 0 : LABEL_W;
  const rowH = narrow ? ROW + 16 : ROW;             // narrow: the name sits above the dots
  const innerW = Math.max(120, width - labelW - SUM_W);
  const height = TOP + rows.length * rowH + 4;
  const x = useMemo(() => d3.scaleLinear().domain([0, 1]).range([R + 1, innerW - R - 1]), [innerW]);
  const dotY = (i: number, h: number) => TOP + i * rowH + (narrow ? 16 : 0) + ROW / 2 + jitter(h) * (ROW / 2 - R - 2);
  const [hover, setHover] = useState<{ p: OffPoint; x: number; y: number; row: number } | null>(null);
  const positions = useDwellPositions(hover?.p ?? null);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(innerW * dpr);
    c.height = Math.round(height * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerW, height);
    ctx.fillStyle = getComputedStyle(c).color;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    rows.forEach((r, i) => {
      for (const p of r.points) {
        const cx = x(p.share), cy = dotY(i, p.height);
        ctx.moveTo(cx + R, cy);
        ctx.arc(cx, cy, R, 0, 2 * Math.PI);
      }
    });
    ctx.fill();
  }, [rows, x, innerW, height, rowH, narrow]);   // eslint-disable-line react-hooks/exhaustive-deps

  const message = viewMessage(view);
  if (message !== null) return <div ref={ref} className="w-full"><VisualMessage>{message}</VisualMessage></div>;
  if (rows.length === 0) return <div ref={ref} className="w-full"><VisualMessage>No blocks in this range yet.</VisualMessage></div>;

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left, py = e.clientY - box.top + TOP;
    const i = Math.floor((py - TOP) / rowH);
    const row = rows[i];
    let best: OffPoint | null = null, bestD = 64;
    for (const p of row?.points ?? []) {
      const dx = x(p.share) - px, dy = dotY(i, p.height) - py, d = dx * dx + dy * dy;
      if (d <= bestD) { bestD = d; best = p; }
    }
    setHover(best ? { p: best, x: x(best.share), y: dotY(i, best.height), row: i } : null);
  };
  const descId = `${instanceKey}-prov-desc`;
  const recordStarts = view.fromHeight !== null && view.recordFrom !== null && view.recordFrom > view.fromHeight;

  return (
    <div ref={ref} className="relative w-full">
      <div className="mb-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-sky-500 align-middle" />block</span>
        <span>right: share over all its blocks</span>
        {recordStarts && <span>since {view.recordFrom!.toLocaleString("en-US")}</span>}
      </div>
      <div className="relative" style={{ height }}>
        <canvas ref={canvas} className="absolute top-0 text-sky-500" aria-hidden style={{ left: labelW, width: innerW, height }} />
        <svg width={width} height={height} role="img" aria-describedby={descId} className="absolute left-0 top-0">
          <desc id={descId}>
            Off-mempool share of each block by template provider: {rows.map(r => `${r.name} ${r.pooled === null ? "no data" : pct(r.pooled)}`).join(", ")}.
          </desc>
          <g transform={`translate(${labelW},0)`} className="text-muted-foreground">
            {[0, 0.25, 0.5, 0.75, 1].map(v => (
              <g key={v}>
                <line x1={x(v)} x2={x(v)} y1={TOP - 4} y2={height - 4} stroke="currentColor" strokeOpacity={0.15} />
                <text x={x(v)} y={12} textAnchor={v === 0 ? "start" : v === 1 ? "end" : "middle"} fontSize={11} fill="currentColor">{v * 100}%</text>
              </g>
            ))}
          </g>
          {rows.map((r, i) => {
            const top = TOP + i * rowH;
            const mid = top + (narrow ? 16 : 0) + ROW / 2;
            return (
              <g key={r.name} className="text-muted-foreground">
                {i > 0 && <line x1={0} x2={width} y1={top} y2={top} stroke="currentColor" strokeOpacity={0.08} />}
                <text x={narrow ? 0 : labelW - 10} y={narrow ? top + 12 : mid + 4} textAnchor={narrow ? "start" : "end"} fontSize={12}
                  className={r.kind === "producer" || r.kind === "miner" ? "fill-foreground" : ""} fill="currentColor">
                  <title>{r.pools.length > 0 ? r.pools.join(", ") : r.name}</title>
                  {r.name.length > 20 && !narrow ? `${r.name.slice(0, 19)}…` : r.name}
                </text>
                <text x={labelW + innerW + 10} y={mid + 4} fontSize={11} fill="currentColor">
                  <tspan className="fill-foreground">{r.pooled === null ? "no data" : pct(r.pooled)}</tspan>
                  <tspan dx={6} fillOpacity={0.7}>{blocksLabel(r.blocks)}</tspan>
                </text>
              </g>
            );
          })}
          {hover && (
            <circle cx={labelW + hover.x} cy={hover.y} r={R + 2.5} fill="none" stroke="currentColor" strokeWidth={1.5} className="text-foreground" />
          )}
          <rect x={labelW} y={TOP} width={innerW} height={height - TOP} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </svg>
        {hover && (
          <div className="pointer-events-none absolute z-10 rounded-md border border-border bg-card px-2 py-1.5 text-xs shadow-md"
            style={{ left: Math.min(labelW + hover.x + 12, Math.max(0, width - 230)), top: hover.y + 10, width: 220 }}>
            <div className="text-muted-foreground">{rows[hover.row].name}</div>
            <BlockTip p={hover.p} runs={positions?.runs} />
          </div>
        )}
      </div>
    </div>
  );
}
