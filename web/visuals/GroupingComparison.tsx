"use client";
import React, { useState } from 'react';
import { useAnalysis } from '@/lib/templates/hooks';
import { computeOverview } from '@/lib/analyses/overview';
import { stack, type Seg } from './geometry';
import { familyColor, HATCH, SectionLabel, Unavailable } from './ui';
import type { VisualDefinition } from './types';

export interface GroupingParams { thresholdBits: number; windowBlocks: number }

const NO = '__not_observed__';
const TITLE = 'Same hashrate, grouped two ways';

export function GroupingComparison({ params }: { params: GroupingParams }) {
  const o = useAnalysis(computeOverview, { thresholdBits: params.thresholdBits, windowBlocks: params.windowBlocks });
  const [hover, setHover] = useState<string | null>(null);
  if (o.shares.unavailable) {
    return (
      <div>
        <SectionLabel title={TITLE} />
        <Unavailable what="hashrate shares" />
      </div>
    );
  }
  const famIdx = new Map<string, number>();
  o.families.forEach((f, i) => f.identities.forEach(id => { if (!famIdx.has(id)) famIdx.set(id, i); }));
  const topItems = o.shares.identities
    .filter(r => famIdx.has(r.name))
    .sort((a, b) => famIdx.get(a.name)! - famIdx.get(b.name)! || b.share - a.share)
    .map(r => ({ key: r.name, w: r.share }))
    .concat([{ key: NO, w: o.shares.notObserved.share }]);
  const botItems = o.families
    .filter(f => f.share)
    .map(f => ({ key: f.id, w: f.share!.share }))
    .concat([{ key: NO, w: o.shares.notObserved.share }]);
  const top = stack(topItems);
  const bot = stack(botItems);
  const famOfIdentity = (id: string) => (id === NO ? NO : o.families[famIdx.get(id)!].id);
  const colorOf = (famId: string) => (famId === NO ? undefined : familyColor(o.families.findIndex(f => f.id === famId)));
  const dim = (famId: string) => (hover && hover !== famId ? 0.3 : 1);
  const bar = (segs: Seg[], famFor: (k: string) => string, label: (k: string) => string) => (
    <div className="relative flex h-[22px] w-full overflow-hidden rounded">
      {segs.map(s => {
        const fam = famFor(s.key);
        return (
          <div
            key={s.key}
            onMouseEnter={() => setHover(fam)}
            onMouseLeave={() => setHover(null)}
            className={`truncate px-1 text-[10px] leading-[22px] ${fam === NO ? 'text-gray-400' : 'text-gray-950'}`}
            style={{ width: `${s.x1 - s.x0}%`, background: fam === NO ? HATCH : colorOf(fam), opacity: dim(fam) }}
          >
            {s.x1 - s.x0 > 6 ? label(s.key) : ''}
          </div>
        );
      })}
    </div>
  );
  return (
    <div>
      <SectionLabel title={TITLE} meta="hover a segment to trace it" />
      <div className="text-[10px] text-gray-500">by pool name</div>
      {bar(top, famOfIdentity, k => (k === NO ? 'Not observed' : k))}
      <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="h-6 w-full">
        {top.filter(s => s.key !== NO).map(s => {
          const b = bot.find(x => x.key === famOfIdentity(s.key));
          if (!b) return null;
          return (
            <polygon
              key={s.key}
              points={`${s.x0},0 ${s.x1},0 ${b.x1},24 ${b.x0},24`}
              fill={colorOf(b.key)}
              opacity={hover ? (hover === b.key ? 0.5 : 0.08) : 0.25}
            />
          );
        })}
      </svg>
      <div className="text-[10px] text-gray-500">by template producer</div>
      {bar(bot, k => k, k => (k === NO ? 'Not observed' : o.families.find(f => f.id === k)?.label ?? k))}
    </div>
  );
}

export const groupingComparisonVisual: VisualDefinition<GroupingParams> = {
  id: 'grouping-comparison',
  title: TITLE,
  description: 'Hashrate by pool name vs. by template producer, linked.',
  scopes: ['live', 'range'],
  defaultParams: { thresholdBits: 16, windowBlocks: 1008 },
  paramsSchema: [
    { key: 'thresholdBits', label: 'Grouping threshold (bits)', kind: 'number', min: 4, max: 64 },
    { key: 'windowBlocks', label: 'Share window (blocks)', kind: 'number', min: 144, max: 4032, step: 144 },
  ],
  Component: function GroupingComparisonVisual({ params }) { return <GroupingComparison params={params} />; },
};
