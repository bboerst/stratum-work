"use client";
import React from 'react';
import { useRouting } from '@/lib/templates/hooks';
import { donatedTotals, latestRoutingBySite } from '@/lib/analyses/routing';
import { contentColor } from '@/utils/colorUtils';
import { routingBars } from './routingView';
import { SectionLabel } from './ui';
import type { VisualDefinition } from './types';

const TITLE = 'Donated hashrate routing';
const MAX_THANKS = 50;
const ths = (x: number) => `${x.toFixed(1)} TH/s`;
const day = (s: string) => {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
};

export function RoutingPanel() {
  const sites = latestRoutingBySite(useRouting());
  if (!sites.length) {
    return (
      <div>
        <SectionLabel title={TITLE} />
        <span className="text-[11px] italic text-gray-500">No routing status received yet</span>
      </div>
    );
  }
  const totals = donatedTotals(sites);
  return (
    <div className="text-xs">
      <SectionLabel title={TITLE} meta="bar = delivered · line = target" />
      {sites.map(r => {
        const bars = routingBars(r);
        const scale = Math.max(r.total_ths, ...bars.map(b => b.target ?? 0), ...bars.map(b => b.delivered)) || 1;
        return (
          <div key={r.site} className="mb-3">
            <div className="mb-1 font-semibold">{r.site} · {ths(r.total_ths)}</div>
            {bars.map(b => (
              <div key={b.id} className="my-0.5 flex items-center gap-2">
                <span className="w-44 shrink-0 truncate text-[10px] text-gray-500" title={b.label}>{b.label}</span>
                <div className="relative h-3 flex-1 rounded-sm bg-gray-100 dark:bg-gray-900">
                  <div className="h-3 rounded-sm" style={{ width: `${Math.min(100, (b.delivered / scale) * 100)}%`, background: contentColor(b.isRemainder ? 'DATUM' : b.label), opacity: b.available ? 1 : 0.4 }} />
                  {b.target !== null && (
                    <i className="absolute -top-0.5 h-4 w-[2px] bg-gray-800 dark:bg-gray-200" style={{ left: `${Math.min(100, (b.target / scale) * 100)}%` }} title={`target ${ths(b.target)}`} />
                  )}
                </div>
                <span className="w-32 shrink-0 text-right font-mono text-[10px] text-gray-500">
                  {b.delivered.toFixed(1)}{b.target !== null ? ` / ${b.target.toFixed(1)}` : ''} TH/s
                </span>
                {!b.available && <span className="rounded bg-gray-200 px-1 text-[9px] uppercase text-gray-600 dark:bg-gray-800 dark:text-gray-400">unavailable</span>}
              </div>
            ))}
          </div>
        );
      })}
      <div className="border-t border-gray-200 pt-2 dark:border-gray-800">
        <div className="font-semibold">Total donated: {ths(totals.totalThs)}</div>
        {totals.workers.length > 0 && (
          <ul className="mt-1 columns-1 text-[11px] text-gray-600 sm:columns-2 dark:text-gray-400">
            {totals.workers.slice(0, MAX_THANKS).map(w => (
              <li key={w.name} className="truncate">{w.name} · {w.ths.toFixed(1)} TH/s · since {day(w.since)}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export const routingPanelVisual: VisualDefinition<Record<string, never>> = {
  id: 'routing-panel',
  title: TITLE,
  description: 'Where donated hashrate is routed per site: delivered vs target per pool, the DATUM remainder, and the thanks list.',
  scopes: ['live'],
  defaultParams: {},
  paramsSchema: [],
  Component: function RoutingPanelVisual() { return <RoutingPanel />; },
};
