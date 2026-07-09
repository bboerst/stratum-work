"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePoolFilter } from "@/components/PoolFilterContext";
import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { StreamDataType, StratumV1Data } from "@/lib/types";
import {
  buildLatencyPlot,
  latencySampleFromMessage,
  LatencyPlot,
  LatencySample,
  pruneLatencySamples,
} from "@/utils/latencyPlot";

interface LatencyHeatmapProps {
  paused: boolean;
  timeWindow: number;
  showLabels: boolean;
  sortByLatest: boolean;
}

type HoveredSample = LatencySample & {
  x: number;
  y: number;
};

const EMPTY_PLOT: LatencyPlot = {
  samples: [],
  poolNames: [],
  timeDomainMs: [0, 0],
  latencyDomainMs: [0, 1],
  maxLatencyMs: 0,
};

const CHART_MARGIN = {
  top: 58,
  right: 34,
  bottom: 42,
  leftWithLabels: 74,
  leftNoLabels: 54,
};

const POOL_COLORS = [
  "#38bdf8",
  "#f97316",
  "#a78bfa",
  "#22c55e",
  "#f43f5e",
  "#eab308",
  "#14b8a6",
  "#fb7185",
  "#60a5fa",
  "#c084fc",
];

function poolColor(poolName: string, poolNames: string[]): string {
  const index = Math.max(0, poolNames.indexOf(poolName));
  return POOL_COLORS[index % POOL_COLORS.length];
}

function formatTime(timestampMs: number): string {
  const date = new Date(timestampMs);
  return date.toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function truncateLabel(ctx: CanvasRenderingContext2D, label: string, maxWidth: number): string {
  if (ctx.measureText(label).width <= maxWidth) return label;
  let result = label;
  while (result.length > 3 && ctx.measureText(result + "...").width > maxWidth) {
    result = result.slice(0, -1);
  }
  return result.length > 3 ? result + "..." : label.slice(0, 3);
}

export default function LatencyHeatmap({
  paused,
  timeWindow,
  showLabels,
  sortByLatest,
}: LatencyHeatmapProps) {
  const { filterByType } = useGlobalDataStream();
  const { isPoolVisible } = usePoolFilter();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const samplesRef = useRef<LatencySample[]>([]);
  const seenSampleIdsRef = useRef<Set<string>>(new Set());
  const pointPositionsRef = useRef<HoveredSample[]>([]);
  const [dimensions, setDimensions] = useState({ width: 900, height: 520 });
  const [plot, setPlot] = useState<LatencyPlot>(EMPTY_PLOT);
  const [hoveredSample, setHoveredSample] = useState<HoveredSample | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const resizeObserver = new ResizeObserver(([entry]) => {
      const width = Math.max(320, Math.floor(entry.contentRect.width));
      const height = Math.max(360, Math.floor(entry.contentRect.height));
      setDimensions({ width, height });
    });

    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    if (paused) return;

    const stratumUpdates = filterByType(StreamDataType.STRATUM_V1);
    if (stratumUpdates.length === 0 && samplesRef.current.length === 0) {
      setPlot(EMPTY_PLOT);
      return;
    }

    let newestTimestampMs = samplesRef.current.reduce(
      (newest, sample) => Math.max(newest, sample.timestampMs),
      0
    );
    let changed = false;

    stratumUpdates.forEach((item) => {
      const data = item.data as StratumV1Data;
      if (!isPoolVisible(data.pool_name)) return;

      const sample = latencySampleFromMessage(data);
      if (!sample || seenSampleIdsRef.current.has(sample.id)) return;

      seenSampleIdsRef.current.add(sample.id);
      samplesRef.current.push(sample);
      newestTimestampMs = Math.max(newestTimestampMs, sample.timestampMs);
      changed = true;
    });

    if (!changed && samplesRef.current.length === 0) return;

    const newestForWindow = newestTimestampMs || Date.now();
    const prunedSamples = pruneLatencySamples(samplesRef.current, newestForWindow, timeWindow);
    const visibleSamples = prunedSamples.filter(sample => isPoolVisible(sample.poolName));
    const nextPlot = buildLatencyPlot(visibleSamples, {
      timeWindowSeconds: timeWindow,
      sortByLatest,
      newestTimestampMs: newestForWindow,
    });

    samplesRef.current = prunedSamples;
    seenSampleIdsRef.current = new Set(prunedSamples.map(sample => sample.id));
    setPlot(nextPlot);
  }, [filterByType, isPoolVisible, paused, sortByLatest, timeWindow]);

  const chartGeometry = useMemo(() => {
    const margin = {
      top: CHART_MARGIN.top,
      right: CHART_MARGIN.right,
      bottom: CHART_MARGIN.bottom,
      left: showLabels ? CHART_MARGIN.leftWithLabels : CHART_MARGIN.leftNoLabels,
    };
    const plotWidth = Math.max(1, dimensions.width - margin.left - margin.right);
    const plotHeight = Math.max(1, dimensions.height - margin.top - margin.bottom);
    return { margin, plotWidth, plotHeight };
  }, [dimensions, showLabels]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = dimensions.width * pixelRatio;
    canvas.height = dimensions.height * pixelRatio;
    canvas.style.width = `${dimensions.width}px`;
    canvas.style.height = `${dimensions.height}px`;

    ctx.resetTransform();
    ctx.scale(pixelRatio, pixelRatio);
    ctx.clearRect(0, 0, dimensions.width, dimensions.height);

    const { margin, plotWidth, plotHeight } = chartGeometry;
    const [startMs, endMs] = plot.timeDomainMs;
    const [minLatencyMs, maxLatencyDomainMs] = plot.latencyDomainMs;
    const domainWidth = Math.max(1, endMs - startMs);
    const latencyRange = Math.max(1, maxLatencyDomainMs - minLatencyMs);
    const pointPositions: HoveredSample[] = [];
    const isDark = document.documentElement.classList.contains("dark");
    const primaryText = isDark ? "rgba(226, 232, 240, 0.92)" : "rgba(15, 23, 42, 0.88)";
    const mutedText = isDark ? "rgba(148, 163, 184, 0.9)" : "rgba(71, 85, 105, 0.86)";
    const gridLine = isDark ? "rgba(148, 163, 184, 0.18)" : "rgba(71, 85, 105, 0.18)";
    const rowFill = isDark ? "rgba(148, 163, 184, 0.08)" : "rgba(15, 23, 42, 0.045)";

    ctx.fillStyle = rowFill;
    ctx.fillRect(margin.left, margin.top, plotWidth, plotHeight);

    ctx.strokeStyle = gridLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top);
    ctx.lineTo(margin.left, margin.top + plotHeight);
    ctx.lineTo(margin.left + plotWidth, margin.top + plotHeight);
    ctx.stroke();

    const timeTickCount = dimensions.width < 640 ? 4 : 6;
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    ctx.fillStyle = mutedText;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    for (let i = 0; i < timeTickCount; i++) {
      const ratio = i / (timeTickCount - 1);
      const x = margin.left + ratio * plotWidth;
      const tickMs = startMs + ratio * domainWidth;

      ctx.strokeStyle = gridLine;
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, margin.top + plotHeight);
      ctx.stroke();

      ctx.fillText(formatTime(tickMs), x, margin.top + plotHeight + 10);
    }

    const latencyTickCount = 5;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    for (let i = 0; i < latencyTickCount; i++) {
      const ratio = i / (latencyTickCount - 1);
      const latencyMs = minLatencyMs + (1 - ratio) * latencyRange;
      const y = margin.top + ratio * plotHeight;

      ctx.strokeStyle = gridLine;
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + plotWidth, y);
      ctx.stroke();

      ctx.fillStyle = mutedText;
      ctx.fillText(`${latencyMs.toFixed(latencyMs >= 10 ? 0 : 1)}ms`, margin.left - 10, y);
    }

    plot.samples.forEach((sample) => {
      const x = margin.left + ((sample.timestampMs - startMs) / domainWidth) * plotWidth;
      const y = margin.top + (1 - ((sample.latencyMs - minLatencyMs) / latencyRange)) * plotHeight;
      const radius = 4.5;

      ctx.fillStyle = poolColor(sample.poolName, plot.poolNames);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();

      pointPositions.push({ ...sample, x, y });
    });

    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    ctx.fillStyle = primaryText;
    ctx.fillText(`${plot.poolNames.length} pools`, margin.left, 10);
    ctx.fillStyle = mutedText;
    ctx.fillText(`${plot.samples.length} latency samples`, margin.left + 92, 10);

    if (showLabels) {
      const legendX = margin.left + 220;
      const legendY = 10;
      const maxLegendX = dimensions.width - 16;
      let offsetX = 0;
      let offsetY = 0;

      ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";

      plot.poolNames.forEach((poolName) => {
        const label = truncateLabel(ctx, poolName, 108);
        const labelWidth = ctx.measureText(label).width;
        const itemWidth = labelWidth + 34;

        if (legendX + offsetX + itemWidth > maxLegendX && offsetX > 0) {
          offsetX = 0;
          offsetY += 16;
        }

        const x = legendX + offsetX;
        const y = legendY + offsetY;
        ctx.fillStyle = poolColor(poolName, plot.poolNames);
        ctx.beginPath();
        ctx.arc(x + 4, y + 6, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = mutedText;
        ctx.fillText(label, x + 12, y);
        offsetX += itemWidth;
      });
    }

    if (plot.samples.length > 1) {
      plot.poolNames.forEach((poolName) => {
        const poolSamples = plot.samples
          .filter(sample => sample.poolName === poolName)
          .sort((a, b) => a.timestampMs - b.timestampMs);

        if (poolSamples.length < 2) return;

        ctx.strokeStyle = poolColor(poolName, plot.poolNames);
        ctx.globalAlpha = 0.26;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        poolSamples.forEach((sample, index) => {
          const x = margin.left + ((sample.timestampMs - startMs) / domainWidth) * plotWidth;
          const y = margin.top + (1 - ((sample.latencyMs - minLatencyMs) / latencyRange)) * plotHeight;
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.globalAlpha = 1;
      });

      plot.samples.forEach((sample) => {
        const x = margin.left + ((sample.timestampMs - startMs) / domainWidth) * plotWidth;
        const y = margin.top + (1 - ((sample.latencyMs - minLatencyMs) / latencyRange)) * plotHeight;

        ctx.fillStyle = poolColor(sample.poolName, plot.poolNames);
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = isDark ? "rgba(2, 6, 23, 0.9)" : "rgba(255, 255, 255, 0.9)";
        ctx.lineWidth = 1;
        ctx.stroke();
      });
    }

    if (plot.samples.length === 0) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = mutedText;
      ctx.font = "14px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
      ctx.fillText("Waiting for latency samples", dimensions.width / 2, dimensions.height / 2);
    }

    pointPositionsRef.current = pointPositions;
  }, [chartGeometry, dimensions, plot, showLabels]);

  useEffect(() => {
    draw();
  }, [draw]);

  const handleMouseMove = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    let nearest: HoveredSample | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    pointPositionsRef.current.forEach((point) => {
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance < nearestDistance && distance <= 10) {
        nearestDistance = distance;
        nearest = point;
      }
    });
    setHoveredSample(nearest);
  }, []);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-background">
      <canvas
        ref={canvasRef}
        className="block h-full w-full"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredSample(null)}
      />
      {hoveredSample && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-gray-600 bg-gray-950/95 px-3 py-2 text-xs text-gray-100 shadow-lg"
          style={{
            left: Math.min(hoveredSample.x + 14, dimensions.width - 210),
            top: Math.max(8, hoveredSample.y - 42),
          }}
        >
          <div className="font-semibold">{hoveredSample.poolName}</div>
          <div>{hoveredSample.latencyMs.toFixed(2)} ms</div>
          <div>{formatTime(hoveredSample.timestampMs)}</div>
          {hoveredSample.method && <div>{hoveredSample.method}</div>}
        </div>
      )}
    </div>
  );
}
