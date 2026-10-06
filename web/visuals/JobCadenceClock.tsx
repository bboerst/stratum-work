"use client";
import React from 'react';
import { useAnalysis } from '@/lib/templates/hooks';
import { computeOverview, DEFAULT_OVERVIEW } from '@/lib/analyses/overview';
import { jobCadence } from '@/lib/analyses/profiles';
import { Insufficient, SectionLabel } from './ui';
import type { VisualDefinition } from './types';

export interface CadenceParams { pool: string }

const TITLE = 'Job cadence clock';
const R = 60, C = 70, BINS = 10;

export function JobCadenceClock({ params }: { params: CadenceParams }) {
  const o = useAnalysis(computeOverview, DEFAULT_OVERVIEW);
  const cad = jobCadence(o.timelines);
  const pool = params.pool && cad.has(params.pool) ? params.pool : o.pools[0];
  const c = pool ? cad.get(pool) : undefined;
  if (!pool || !c || c.dominantMs === null) {
    return (
      <div>
        <SectionLabel title={TITLE} meta={pool ?? undefined} />
        <Insufficient what="jobs (needs ≥ 3 intervals)" />
      </div>
    );
  }
  const lo = Math.min(...c.intervalsMs), hi = Math.max(...c.intervalsMs);
  const w = (hi - lo) / BINS || 1;
  const bins = new Array<number>(BINS).fill(0);
  for (const x of c.intervalsMs) bins[Math.min(BINS - 1, Math.floor((x - lo) / w))]++;
  const top = Math.max(...bins);
  const s = c.dominantMs / 1000;
  return (
    <div>
      <SectionLabel title={TITLE} meta={`${pool} · tick = template at its phase within the median interval`} />
      <div className="flex flex-col items-center gap-2">
        <svg width={C * 2} height={C * 2} viewBox={`0 0 ${C * 2} ${C * 2}`}>
          <circle cx={C} cy={C} r={R} fill="none" stroke="currentColor" className="text-gray-300 dark:text-gray-700" />
          {c.phases.map((ph, i) => {
            const a = 2 * Math.PI * ph - Math.PI / 2;
            const x1 = C + Math.cos(a) * (R - 6), y1 = C + Math.sin(a) * (R - 6);
            const x2 = C + Math.cos(a) * (R + 6), y2 = C + Math.sin(a) * (R + 6);
            return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#f59e0b" strokeOpacity={0.5} strokeWidth={1.5} />;
          })}
          <text x={C} y={C + 4} textAnchor="middle" className="fill-gray-600 font-mono text-[12px] dark:fill-gray-300">
            {`${s.toLocaleString('en-US', { maximumFractionDigits: s < 10 ? 1 : 0 })}s`}
          </text>
        </svg>
        <div className="w-full">
          <div className="flex h-10 items-end gap-px">
            {bins.map((n, i) => (
              <i
                key={i}
                className="inline-block flex-1 rounded-t-sm bg-gray-600 dark:bg-gray-300"
                style={{ height: `${(n / top) * 100}%`, minHeight: n ? 1 : 0 }}
                title={`${Math.round(lo + i * w).toLocaleString('en-US')}–${Math.round(lo + (i + 1) * w).toLocaleString('en-US')} ms: ${n.toLocaleString('en-US')}`}
              />
            ))}
          </div>
          <div className="flex justify-between font-mono text-[9px] text-gray-500">
            <span>{Math.round(lo).toLocaleString('en-US')} ms</span>
            <span>interval histogram · {c.intervalsMs.length.toLocaleString('en-US')} gaps</span>
            <span>{Math.round(hi).toLocaleString('en-US')} ms</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export const jobCadenceClockVisual: VisualDefinition<CadenceParams> = {
  id: 'job-cadence-clock',
  title: TITLE,
  description: 'When a pool sends new jobs, as phases within its median job interval, plus the interval histogram.',
  scopes: ['live', 'range', 'height'],
  defaultParams: { pool: '' },
  paramsSchema: [{ key: 'pool', label: 'Pool (empty = first)', kind: 'pool' }],
  Component: function JobCadenceClockVisual({ params }) { return <JobCadenceClock params={params} />; },
};
