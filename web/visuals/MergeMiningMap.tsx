"use client";
import React from 'react';
import { useAnalysis } from '@/lib/templates/hooks';
import { computeOverview, DEFAULT_OVERVIEW } from '@/lib/analyses/overview';
import { mergeMiningMap } from '@/lib/analyses/profiles';
import { contentColor } from '@/utils/colorUtils';
import { Insufficient, SectionLabel } from './ui';
import type { VisualDefinition } from './types';

export type MergeMiningParams = Record<string, never>;

const TITLE = 'Merge-mining map';

export function MergeMiningMap() {
  const o = useAnalysis(computeOverview, DEFAULT_OVERVIEW);
  const m = mergeMiningMap(o.timelines);
  const byCell = new Map(m.cells.map(c => [`${c.pool}\u0000${c.protocol}`, c.latest] as [string, string]));
  const pools = Array.from(new Set(m.cells.map(c => c.pool)));
  return (
    <div>
      <SectionLabel title={TITLE} meta="latest commitment per pool; same color = identical content" />
      {m.protocols.length === 0 ? <Insufficient what="merge-mining commitments" /> : (
        <div className="overflow-x-auto">
          <table className="text-[10px]">
            <thead>
              <tr>
                <th />
                {m.protocols.map(p => <th key={p} className="px-1 font-normal text-gray-500">{p}</th>)}
              </tr>
            </thead>
            <tbody>
              {pools.map(pool => (
                <tr key={pool}>
                  <td className="max-w-[120px] truncate pr-2 text-gray-500" title={pool}>{pool}</td>
                  {m.protocols.map(proto => {
                    const latest = byCell.get(`${pool}\u0000${proto}`);
                    return (
                      <td key={proto} className="px-1 text-center">
                        {latest === undefined
                          ? <span className="text-gray-400" title={`${pool} · ${proto}: none`}>–</span>
                          : <i className="inline-block h-[14px] w-[22px] rounded-sm" style={{ background: contentColor(latest) }} title={`${pool} · ${proto}: ${latest}`} />}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {m.shared.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-[10px] text-gray-500">
              {m.shared.map(s => (
                <li key={`${s.protocol}\u0000${s.content}`} className="flex items-center gap-1">
                  <i className="inline-block h-2 w-2 rounded-sm" style={{ background: contentColor(s.content) }} />
                  {s.protocol} · identical content · {s.pools.join(', ')}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export const mergeMiningMapVisual: VisualDefinition<MergeMiningParams> = {
  id: 'merge-mining-map',
  title: TITLE,
  description: 'Latest merge-mining commitments per pool and protocol; identical content shares a color.',
  scopes: ['live', 'range', 'height'],
  defaultParams: {},
  paramsSchema: [],
  Component: function MergeMiningMapVisual() { return <MergeMiningMap />; },
};
