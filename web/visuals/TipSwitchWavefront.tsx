"use client";
import React from 'react';
import { useAnalysis } from '@/lib/templates/hooks';
import { computeOverview, DEFAULT_OVERVIEW } from '@/lib/analyses/overview';
import { tipRows } from '@/lib/analyses/evidenceView';
import { contentColor } from '@/utils/colorUtils';
import { Insufficient, SectionLabel } from './ui';
import type { VisualDefinition } from './types';

export interface WavefrontParams { blocks: number }

const TITLE = 'Tip-switch wavefront';

export function TipSwitchWavefront({ params }: { params: WavefrontParams }) {
  const o = useAnalysis(computeOverview, DEFAULT_OVERVIEW);
  const rows = tipRows(o, o.pools, params.blocks);
  const all = rows.reduce<number[]>((acc, r) => { for (const x of r.offsets) acc.push(x.ms); return acc; }, []).sort((a, b) => a - b);
  const p95 = all.length ? all[Math.min(all.length - 1, Math.floor(all.length * 0.95))] : 0;
  const max = Math.max(50, p95);
  return (
    <div>
      <SectionLabel
        title={<>{TITLE}<span className="ml-1.5 rounded bg-gray-200 px-1 text-[9px] font-normal uppercase text-gray-600 dark:bg-gray-800 dark:text-gray-400">experimental</span></>}
        meta={`row = new tip; dot = pool, latency-corrected offset from first switch; x = 0–${Math.round(max).toLocaleString('en-US')} ms (p95)`}
      />
      {rows.length === 0 ? <Insufficient what="new tips" /> : (
        <div>
          {rows.map(r => (
            <div key={r.prevHash} className="my-0.5 flex items-center gap-1">
              <span className="w-20 shrink-0 font-mono text-[10px] text-gray-500">#{r.height.toLocaleString('en-US')}</span>
              <svg height={12} className="w-full flex-1 rounded-sm bg-gray-100 dark:bg-gray-900">
                {r.offsets.map(p => (
                  <svg key={p.pool} x={`${Math.min(97, (p.ms / max) * 100)}%`} y={0} overflow="visible">
                    <circle cx={3} cy={6} r={3} fill={contentColor(p.pool)} opacity={p.ms > max ? 0.5 : 1}>
                      <title>{`${p.pool}: +${Math.round(p.ms).toLocaleString('en-US')} ms${p.ms > max ? ' (beyond p95, drawn at edge)' : ''}`}</title>
                    </circle>
                  </svg>
                ))}
              </svg>
              <span className="w-10 shrink-0 text-right font-mono text-[9px] text-gray-500">{r.offsets.length} pools</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const tipSwitchWavefrontVisual: VisualDefinition<WavefrontParams> = {
  id: 'tip-switch-wavefront',
  title: TITLE,
  description: 'For each recent new tip, when each pool switched relative to the first pool to switch.',
  scopes: ['live', 'range', 'height'],
  defaultParams: { blocks: 12 },
  paramsSchema: [{ key: 'blocks', label: 'Tips shown', kind: 'number', min: 1, max: 48 }],
  Component: function TipSwitchWavefrontVisual({ params }) { return <TipSwitchWavefront params={params} />; },
};
