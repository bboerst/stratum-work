"use client";
import React from 'react';
import { useAnalysis } from '@/lib/templates/hooks';
import { computeOverview, DEFAULT_OVERVIEW } from '@/lib/analyses/overview';
import { emptyBlockWindow } from '@/lib/analyses/profiles';
import { HATCH, Insufficient, SectionLabel } from './ui';
import type { VisualDefinition } from './types';

export type EmptyWindowParams = Record<string, never>;

const TITLE = 'Empty-block window';
const CAP_MS = 5000;
const BAR_H = 24;
const RECENT = 24;

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function EmptyBlockWindow() {
  const o = useAnalysis(computeOverview, DEFAULT_OVERVIEW);
  const rows = Array.from(emptyBlockWindow(o.timelines).entries())
    .map(([pool, rs]) => ({ pool, rs: rs.slice(-RECENT) }))
    .filter(r => r.rs.length > 0)
    .sort((a, b) => a.pool.localeCompare(b.pool));
  return (
    <div>
      <SectionLabel title={TITLE} meta="per new tip: ms until the first template with branches; bar height capped at 5 s" />
      {rows.length === 0 ? <Insufficient what="new tips" /> : (
        <div>
          {rows.map(({ pool, rs }) => {
            const med = median(rs.map(r => r.emptyMs).filter((x): x is number => x !== null));
            return (
              <div key={pool} className="my-1 flex items-end gap-1">
                <span className="w-20 shrink-0 truncate text-[10px] text-gray-500" title={pool}>{pool}</span>
                <div className="flex flex-1 items-end gap-px" style={{ height: BAR_H }}>
                  {rs.map((r, i) => r.emptyMs === null ? (
                    <i key={i} className="inline-block w-[6px]" style={{ height: 6, background: HATCH }} title={`${r.prevHash.slice(0, 16)}…: no branched template`} />
                  ) : (
                    <i
                      key={i}
                      className="inline-block w-[6px] rounded-t-sm bg-gray-600 dark:bg-gray-300"
                      style={{ height: Math.max(1, (Math.min(CAP_MS, r.emptyMs) / CAP_MS) * BAR_H) }}
                      title={`${r.prevHash.slice(0, 16)}…: ${Math.round(r.emptyMs).toLocaleString('en-US')} ms${r.emptyMs > CAP_MS ? ' (capped)' : ''}`}
                    />
                  ))}
                </div>
                <span className="w-28 shrink-0 text-right font-mono text-[10px] text-gray-500">
                  {med === null ? 'median: insufficient' : `median ${Math.round(med).toLocaleString('en-US')} ms`}
                </span>
              </div>
            );
          })}
          <div className="mt-1 flex items-center gap-1 pl-[84px] text-[10px] text-gray-500">
            <i className="inline-block h-[6px] w-[6px]" style={{ background: HATCH }} /> no branched template
          </div>
        </div>
      )}
    </div>
  );
}

export const emptyBlockWindowVisual: VisualDefinition<EmptyWindowParams> = {
  id: 'empty-block-window',
  title: TITLE,
  description: 'Per pool, how long after each new tip its templates stayed empty (no merkle branches).',
  scopes: ['live', 'range', 'height'],
  defaultParams: {},
  paramsSchema: [],
  Component: function EmptyBlockWindowVisual() { return <EmptyBlockWindow />; },
};
