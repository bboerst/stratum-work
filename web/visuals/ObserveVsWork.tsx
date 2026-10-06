"use client";
import React from 'react';
import { useAnalysis } from '@/lib/templates/hooks';
import type { TemplateStore } from '@/lib/templates/store';
import type { Scope, Template } from '@/lib/templates/types';
import { compareModes, observeEndMs } from '@/lib/analyses/observeVsWork';
import { changeKey } from '@/lib/analyses/evidence/identicalChanges';
import { getChangeContentKey } from '@/utils/templateChangeDetection';
import { contentColor, getMerkleColor, NO_CHANGE_COLOR } from '@/utils/colorUtils';
import { ago, Insufficient, pct, SectionLabel } from './ui';
import type { VisualDefinition } from './types';

export interface ObserveVsWorkParams { pool: string }

const TITLE = 'Observe vs work';
const STRIP = 20;

function analyse(store: TemplateStore, p: { pool: string; scope: Scope }) {
  const nowMs = observeEndMs(p.scope, Date.now());
  const templates = store.templates().filter(t => t.receivedAtMs <= nowMs);
  let pool = p.pool;
  if (!pool) {
    const modes = new Map<string, Set<string>>();
    for (const t of templates) {
      const s = modes.get(t.pool) ?? new Set<string>();
      s.add(t.mode);
      modes.set(t.pool, s);
    }
    pool = Array.from(modes.keys()).sort().find(k => modes.get(k)!.size === 2) ?? '';
  }
  return { pool, nowMs, ...compareModes(templates, pool, nowMs) };
}

function ModeRow({ label, ts, fromMs, nowMs }: { label: string; ts: Template[]; fromMs: number; nowMs: number }) {
  const shown = ts.slice(-STRIP);
  const span = Math.max(1, nowMs - fromMs);
  const x = (t: number) => Math.min(99, Math.max(0, ((t - fromMs) / span) * 100));
  const tips = ts.filter((t, i) => i > 0 && t.receivedAtMs >= fromMs && t.prevHash !== ts[i - 1].prevHash);
  const changes = ts.filter(t => t.receivedAtMs >= fromMs && t.change?.hasChanges);
  return (
    <div className="my-1 flex items-start gap-1">
      <span className="w-14 shrink-0 pt-0.5 text-[10px] text-gray-500">{label}</span>
      <div className="min-w-0 flex-1">
        <div className="flex gap-0.5">
          {shown.length === 0 && <span className="text-[10px] italic text-gray-500">no templates</span>}
          {shown.map(t => {
            const b = t.merkleBranches[0] ?? '';
            return <span key={t.mid} className="inline-block h-[14px] w-[14px] rounded-sm" style={{ background: getMerkleColor(b) }} title={`${b || 'no branches'} · ${ago(t.receivedAtMs, nowMs)}`} />;
          })}
        </div>
        <svg height={16} className="mt-0.5 w-full rounded-sm bg-gray-100 dark:bg-gray-900">
          {changes.map(t => {
            // Same encoding as the evidence card's change bars: tip-only changes are faded.
            const own = changeKey(t.change);
            const key = own || getChangeContentKey(t.change!);
            return (
              <rect key={t.mid} x={`${x(t.receivedAtMs)}%`} y={2} width={3} height={12} fill={key ? contentColor(key) : NO_CHANGE_COLOR} opacity={own ? 1 : 0.25}>
                <title>{ago(t.receivedAtMs, nowMs)}</title>
              </rect>
            );
          })}
          {tips.map(t => (
            <line key={`tip-${t.mid}`} x1={`${x(t.receivedAtMs)}%`} x2={`${x(t.receivedAtMs)}%`} y1={0} y2={16} stroke="currentColor" strokeWidth={1} className="text-gray-700 dark:text-gray-300">
              <title>{`new tip · ${ago(t.receivedAtMs, nowMs)}`}</title>
            </line>
          ))}
        </svg>
      </div>
    </div>
  );
}

export function ObserveVsWork({ scope, params }: { scope: Scope; params: ObserveVsWorkParams }) {
  const r = useAnalysis(analyse, { pool: params.pool, scope });
  const shownFrom = [r.observe, r.work].map(ts => ts.slice(-STRIP)[0]?.receivedAtMs).filter((t): t is number => t !== undefined);
  const fromMs = shownFrom.length ? Math.min(...shownFrom) : r.nowMs;
  return (
    <div className="text-xs">
      <SectionLabel title={TITLE} meta={r.pool ? `${r.pool} · first merkle branch per template · bars = changes · lines = new tip` : undefined} />
      {!r.pool ? <Insufficient what="work-mode data" /> : (
        <>
          <ModeRow label="observe" ts={r.observe} fromMs={fromMs} nowMs={r.nowMs} />
          <ModeRow label="work" ts={r.work} fromMs={fromMs} nowMs={r.nowMs} />
          <div className="mt-1 text-[11px] text-gray-600 dark:text-gray-400">
            {r.identicalShare === null
              ? <Insufficient what="work-mode data" />
              : `identical ${pct(r.identicalShare)} of ${Math.round(r.overlapMs / 60000).toLocaleString('en-US')} min`}
          </div>
        </>
      )}
    </div>
  );
}

export const observeVsWorkVisual: VisualDefinition<ObserveVsWorkParams> = {
  id: 'observe-vs-work',
  title: TITLE,
  description: 'A pool’s templates on an observe connection next to the work it sends a hashing connection: first merkle branch, changes, and new tips.',
  scopes: ['live', 'range'],
  defaultParams: { pool: '' },
  paramsSchema: [{ key: 'pool', label: 'Pool (empty = first with both modes)', kind: 'pool' }],
  Component: function ObserveVsWorkVisual({ scope, params }) { return <ObserveVsWork scope={scope} params={params} />; },
};
