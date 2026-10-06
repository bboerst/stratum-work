"use client";
import React from 'react';
import { useAnalysis } from '@/lib/templates/hooks';
import { computeOverview } from '@/lib/analyses/overview';
import { similarityMatrix } from '@/lib/analyses/evidenceView';
import { HATCH, SectionLabel } from './ui';
import type { VisualDefinition } from './types';

export interface GridParams { thresholdBits: number; windowBlocks: number; maxPools: number }

const TITLE = 'Pair similarity grid';

export function PairSimilarityGrid({ params, onPickPair }: { params: GridParams; onPickPair?: (a: string, b: string) => void }) {
  const o = useAnalysis(computeOverview, { thresholdBits: params.thresholdBits, windowBlocks: params.windowBlocks });
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const f of o.families) for (const m of f.members.slice().sort()) if (!seen.has(m)) { seen.add(m); ordered.push(m); }
  for (const p of o.pools) if (!seen.has(p)) { seen.add(p); ordered.push(p); }
  const pools = ordered.slice(0, params.maxPools);
  const m = similarityMatrix(o, pools);
  const cols = `80px repeat(${pools.length}, 22px)`;
  return (
    <div>
      <SectionLabel title={TITLE} meta="total evidence per pair, bits; darker = more shared observations" />
      {pools.length < 2 ? (
        <span className="text-[11px] italic text-gray-500">insufficient pools</span>
      ) : (
        <div className="overflow-x-auto">
          <div className="grid gap-px text-[9px]" style={{ gridTemplateColumns: cols }}>
            <div />
            {pools.map(p => <div key={p} title={p} className="truncate text-center text-gray-500">{p.slice(0, 3)}</div>)}
            {pools.map((a, i) => (
              <React.Fragment key={a}>
                <div className="truncate pr-1 text-[10px] leading-[22px] text-gray-500" title={a}>{a}</div>
                {pools.map((b, j) => {
                  if (i === j) return <div key={b} className="h-[22px] w-[22px]" />;
                  const bits = m.bits[i][j];
                  if (bits === null) {
                    return (
                      <button
                        key={b}
                        type="button"
                        aria-label={`${a} · ${b}: insufficient`}
                        title={`${a} · ${b}: insufficient`}
                        onClick={() => onPickPair?.(a, b)}
                        className="h-[22px] w-[22px] rounded-sm border border-gray-200 dark:border-gray-800"
                        style={{ background: HATCH }}
                      />
                    );
                  }
                  return (
                    <button
                      key={b}
                      type="button"
                      aria-label={`${a} · ${b}: ${bits.toFixed(1)} bits`}
                      title={`${a} · ${b}: ${bits.toFixed(1)} bits`}
                      onClick={() => onPickPair?.(a, b)}
                      className="h-[22px] w-[22px] rounded-sm border border-gray-200 dark:border-gray-800"
                      style={{ background: `rgba(245,158,11,${Math.min(1, bits / 64)})` }}
                    />
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export const pairSimilarityGridVisual: VisualDefinition<GridParams> = {
  id: 'pair-similarity-grid',
  title: TITLE,
  description: 'Total evidence in bits for every pair of pools.',
  scopes: ['live', 'range', 'height'],
  defaultParams: { thresholdBits: 16, windowBlocks: 1008, maxPools: 16 },
  paramsSchema: [{ key: 'maxPools', label: 'Pools shown', kind: 'number', min: 4, max: 40 }],
  Component: function PairSimilarityGridVisual({ params }) { return <PairSimilarityGrid params={params} />; },
};
