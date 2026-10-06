"use client";
import React from 'react';
import Link from 'next/link';
import { useAnalysis, useBlocks } from '@/lib/templates/hooks';
import { computeOverview } from '@/lib/analyses/overview';
import { ago, btc, familyColor, HATCH, pct, RangeBar, SectionLabel, txRange, Unavailable } from './ui';
import type { VisualDefinition } from './types';

export interface CandidateParams { thresholdBits: number; windowBlocks: number; recentBlocks: number }

export function CandidateBlocks({ params, selectedId, onSelect }: { params: CandidateParams; selectedId?: string; onSelect?: (id: string) => void }) {
  const o = useAnalysis(computeOverview, { thresholdBits: params.thresholdBits, windowBlocks: params.windowBlocks });
  const blocks = useBlocks().slice(0, params.recentBlocks);
  const even = o.families.length ? 1 / o.families.length : 1;
  return (
    <div>
      <SectionLabel title="Templates being mined now" meta={`groupings: last 60 min · shares: last ${params.windowBlocks.toLocaleString()} blocks · bars = 95% range`} />
      {o.shares.unavailable && <Unavailable what="hashrate shares" />}
      <div className="flex items-stretch gap-1.5">
        <div className="flex flex-1 gap-1.5">
          {o.families.map((f, i) => (
            <button
              key={f.id}
              type="button"
              onClick={() => onSelect?.(f.id)}
              className={`flex min-h-[78px] min-w-[56px] flex-col justify-between rounded p-1.5 text-left text-[11px] font-semibold text-gray-950 ${selectedId === f.id ? 'outline outline-2 outline-offset-1 outline-white' : ''}`}
              style={{ flexGrow: f.share ? Math.max(f.share.share, 0.01) : even, flexBasis: 0, background: familyColor(i) }}
            >
              <span>
                {f.label}
                {f.members.length > 1 && <span className="font-normal opacity-70"> {f.members.length} pools</span>}
              </span>
              {f.current && (
                <span className="font-normal opacity-80">
                  {txRange(f.current.txCountRange)} · {btc(f.current.feesSats)}
                  {f.current.merkleBranches.length === 0 && ' · empty'}
                </span>
              )}
              {f.share && (
                <span>
                  {pct(f.share.share)}
                  <RangeBar lo={f.share.lo} hi={f.share.hi} />
                </span>
              )}
            </button>
          ))}
          {!o.shares.unavailable && (
            <div
              className="flex min-h-[78px] min-w-[56px] flex-col justify-between rounded p-1.5 text-[11px] text-gray-400"
              style={{ flexGrow: Math.max(o.shares.notObserved.share, 0.01), flexBasis: 0, background: HATCH }}
            >
              <span>Not observed</span>
              <span>
                {pct(o.shares.notObserved.share)}
                <RangeBar lo={o.shares.notObserved.lo} hi={o.shares.notObserved.hi} />
              </span>
            </div>
          )}
        </div>
        {blocks.length > 0 && <div className="mx-1.5 w-0.5 bg-gray-600" />}
        {blocks.map(b => (
          <Link key={b.hash} href={`/height/${b.height}`} className="flex w-[58px] flex-col justify-between rounded bg-gray-700 p-1.5 text-[11px] text-gray-300">
            <span>#{b.height.toLocaleString()}</span>
            <span className="truncate">{b.mining_pool?.name ?? 'Unknown'}</span>
            <span className="text-gray-500">{b.timestamp ? ago(Date.parse(b.timestamp)) : ''}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

export const candidateBlocksVisual: VisualDefinition<CandidateParams> = {
  id: 'candidate-blocks',
  title: 'Templates being mined now',
  description: 'One block per template grouping, width = share of hashrate with 95% range.',
  scopes: ['live', 'range'],
  defaultParams: { thresholdBits: 16, windowBlocks: 1008, recentBlocks: 3 },
  paramsSchema: [
    { key: 'thresholdBits', label: 'Grouping threshold (bits)', kind: 'number', min: 4, max: 64, step: 1 },
    { key: 'windowBlocks', label: 'Share window (blocks)', kind: 'number', min: 144, max: 4032, step: 144 },
    { key: 'recentBlocks', label: 'Recent blocks shown', kind: 'number', min: 0, max: 6 },
  ],
  Component: function CandidateBlocksVisual({ params }) { return <CandidateBlocks params={params} />; },
};
