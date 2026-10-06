"use client";
import React, { useState } from 'react';
import { useAnalysis } from '@/lib/templates/hooks';
import { computeOverview } from '@/lib/analyses/overview';
import {
  changeRows, channelSummaries, defaultSelection, merkleStrips, payoutRows, selectionFromPair, selectionFromPools, tipRows,
  type ChannelSummary, type EvidenceSelection,
} from '@/lib/analyses/evidenceView';
import type { Overview } from '@/lib/analyses/overview';
import { contentColor, getMerkleColor, NO_CHANGE_COLOR } from '@/utils/colorUtils';
import { ago, BitsBar } from './ui';
import type { VisualDefinition } from './types';

export interface EvidenceParams { thresholdBits: number; windowBlocks: number; pools: string[]; tipBlocks: number }

const CHANGE_WINDOW_MS = 10 * 60_000;
const CONTRAST_NOTE = 'reference, not in selection';

function resolveSelection(o: Overview, pools: string[], familyId?: string): EvidenceSelection {
  if (pools.length === 2) return selectionFromPair(o, pools[0], pools[1]);
  if (pools.length >= 3) return selectionFromPools(o, pools);
  const fam = familyId ? o.families.find(f => f.id === familyId) : undefined;
  if (fam && fam.members.length) return selectionFromPools(o, fam.members);
  return defaultSelection(o);
}

function Row({ title, caption, tag, summary, children }: { title: string; caption: string; tag?: string; summary: ChannelSummary; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[170px_1fr_140px] items-center gap-3 border-t border-gray-200 py-2.5 dark:border-gray-800">
      <div>
        <div className="text-xs font-semibold">
          {title}
          {tag && <span className="ml-1.5 rounded bg-gray-200 px-1 text-[9px] font-normal uppercase text-gray-600 dark:bg-gray-800 dark:text-gray-400">{tag}</span>}
        </div>
        <div className="mt-0.5 text-[10px] text-gray-500">{caption}</div>
      </div>
      <div className="min-w-0">{children}</div>
      <div><BitsBar bits={summary.bits} insufficient={summary.insufficient} /></div>
    </div>
  );
}

function PoolName({ name, contrast }: { name: string; contrast?: boolean }) {
  return <span className="w-20 shrink-0 truncate text-[10px] text-gray-500" title={contrast ? `${name} (${CONTRAST_NOTE})` : name}>{name}</span>;
}

function TxSelection({ o, members, contrast }: { o: Overview; members: string[]; contrast: string | null }) {
  const strips = merkleStrips(o, contrast ? members.concat([contrast]) : members);
  return (
    <div>
      {strips.map(s => {
        const isContrast = s.pool === contrast;
        return (
          <div key={s.pool} className="my-0.5 flex items-center gap-0.5" style={{ opacity: isContrast ? 0.4 : 1 }}>
            <PoolName name={s.pool} contrast={isContrast} />
            {s.branches.map((b, i) => <span key={i} className="inline-block h-[14px] w-[22px] rounded-sm" style={{ background: getMerkleColor(b) }} title={b} />)}
            {s.branches.length === 0 && <span className="text-[10px] italic text-gray-500">no branches</span>}
            {s.atMs !== null && <span className="ml-2 text-[10px] text-gray-500">{ago(s.atMs, o.nowMs)}</span>}
            {isContrast && <span className="ml-2 text-[10px] italic text-gray-500">{CONTRAST_NOTE}</span>}
          </div>
        );
      })}
    </div>
  );
}

function IdenticalChanges({ o, members, contrast }: { o: Overview; members: string[]; contrast: string | null }) {
  const since = o.nowMs - CHANGE_WINDOW_MS;
  const rows = changeRows(o, contrast ? members.concat([contrast]) : members, since);
  const x = (t: number) => Math.min(99, Math.max(0, ((t - since) / CHANGE_WINDOW_MS) * 100));
  return (
    <div>
      {rows.map(r => {
        const isContrast = r.pool === contrast;
        return (
          <div key={r.pool} className="my-0.5 flex items-center gap-1" style={{ opacity: isContrast ? 0.4 : 1 }}>
            <PoolName name={r.pool} contrast={isContrast} />
            <svg height={16} className="w-full flex-1 rounded-sm bg-gray-100 dark:bg-gray-900">
              {r.changes.map((c, i) => (
                <rect key={i} x={`${x(c.atMs)}%`} y={2} width={3} height={12} fill={c.key ? contentColor(c.key) : NO_CHANGE_COLOR} opacity={c.common ? 0.25 : 1}>
                  <title>{`${ago(c.atMs, o.nowMs)}${c.common ? ' · also made by most pools' : ''}`}</title>
                </rect>
              ))}
            </svg>
          </div>
        );
      })}
      <div className="flex justify-between pl-[84px] text-[9px] text-gray-500"><span>−10 min</span><span>now</span></div>
    </div>
  );
}

function TipSwitching({ o, members, tipBlocks }: { o: Overview; members: string[]; tipBlocks: number }) {
  const rows = tipRows(o, members, tipBlocks);
  if (!rows.length) return <span className="text-[10px] italic text-gray-500">no new blocks with two or more selected pools switching</span>;
  return (
    <div>
      {rows.map(r => {
        const max = Math.max(50, ...r.offsets.map(x => x.ms));
        return (
          <div key={r.prevHash} className="my-0.5 flex items-center gap-1">
            <span className="w-20 shrink-0 font-mono text-[10px] text-gray-500">#{r.height.toLocaleString()}</span>
            <svg height={12} className="w-full flex-1 rounded-sm bg-gray-100 dark:bg-gray-900">
              {r.offsets.map(p => (
                <svg key={p.pool} x={`${Math.min(97, (p.ms / max) * 100)}%`} y={0} overflow="visible">
                  <circle cx={3} cy={6} r={3} fill={contentColor(p.pool)}><title>{`${p.pool}: +${Math.round(p.ms)} ms`}</title></circle>
                </svg>
              ))}
            </svg>
            <span className="w-14 shrink-0 text-right font-mono text-[9px] text-gray-500">0–{Math.round(max)} ms</span>
          </div>
        );
      })}
      <div className="mt-1 flex flex-wrap gap-2 pl-[84px] text-[10px] text-gray-500">
        {members.map(m => (
          <span key={m} className="flex items-center gap-1"><i className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: contentColor(m) }} />{m}</span>
        ))}
      </div>
    </div>
  );
}

const TAG = 'mr-1 mb-1 inline-block rounded bg-gray-200 px-1.5 py-px text-[10px] text-gray-700 dark:bg-gray-800 dark:text-gray-300';

function Payouts({ o, members }: { o: Overview; members: string[] }) {
  const p = payoutRows(o, members);
  const holders = new Map<string, number>();
  for (const ob of o.observations.payoutsMergeMining) {
    const d = ob.detail as { kind: string; address?: string };
    if (d.kind === 'address' && d.address) holders.set(d.address, ob.pools.length);
  }
  if (!p.sharedAddresses.length && !p.commitments.length && !p.mismatches.length) return <span className="text-[10px] italic text-gray-500">none observed</span>;
  return (
    <div>
      {p.sharedAddresses.map(a => <span key={a} className={TAG} title={a}>payout {a.slice(0, 6)}…{a.slice(-4)} · shared by {holders.get(a) ?? 0}</span>)}
      {p.commitments.map((c, i) => <span key={`${c.protocol}:${c.content}:${i}`} className={TAG} title={c.content}>{c.protocol} commitment · identical content · {c.pools.join(', ')}</span>)}
      {p.mismatches.map(m => <span key={m.pool} className={TAG}>pool label &quot;{m.pool}&quot; · identity {m.identity}</span>)}
    </div>
  );
}

export function EvidenceCard({ params, familyId, onPickPair }: { params: EvidenceParams; familyId?: string; onPickPair?: (a: string, b: string) => void }) {
  const o = useAnalysis(computeOverview, { thresholdBits: params.thresholdBits, windowBlocks: params.windowBlocks });
  const inputKey = `${params.pools.join(',')}|${familyId ?? ''}`;
  const [picked, setPicked] = useState<{ key: string; pair: [string, string] } | null>(null);
  const base = resolveSelection(o, params.pools, familyId);
  // Local picks apply only when the parent does not own the selection, and reset when the inputs change.
  const sel = !onPickPair && picked && picked.key === inputKey ? selectionFromPair(o, picked.pair[0], picked.pair[1]) : base;
  const { members, contrast } = sel;
  const pick = (a: string, b: string) => {
    if (!a || !b || a === b) return;
    if (onPickPair) onPickPair(a, b); else setPicked({ key: inputKey, pair: [a, b] });
  };
  const sum = channelSummaries(o, members);
  const [pa, pb] = [members[0] ?? '', members[1] ?? ''];
  const select = (value: string, onChange: (v: string) => void, label: string) => (
    <select aria-label={label} value={value} onChange={e => onChange(e.target.value)} className="rounded border border-gray-300 bg-transparent px-1 py-0.5 text-[11px] dark:border-gray-700">
      {!value && <option value="">—</option>}
      {o.pools.map(p => <option key={p} value={p}>{p}</option>)}
    </select>
  );
  return (
    <div className="text-xs">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] text-gray-500">
          Evidence for <span className="font-semibold text-gray-800 dark:text-gray-200">{members.length ? members.join(' · ') : '—'}</span> · last 60 min / last {params.tipBlocks} blocks
        </div>
        {o.pools.length >= 2 && (
          <div className="flex items-center gap-1 text-[10px] text-gray-500">
            {select(pa, v => pick(v, pb), 'Pool A')}
            <span>vs</span>
            {select(pb, v => pick(pa, v), 'Pool B')}
          </div>
        )}
      </div>
      <Row title="1 · Transaction selection" caption="current merkle branches, colored by hash" summary={sum.txSelection}>
        <TxSelection o={o} members={members} contrast={contrast} />
      </Row>
      <Row title="2 · Identical changes" caption="change-detection bars colored by what changed; faded = change most pools also made" summary={sum.identicalChanges}>
        <IdenticalChanges o={o} members={members} contrast={contrast} />
      </Row>
      <Row title="3 · New-tip switching" tag="experimental" caption="each row = one new block; dot = latency-corrected switch time relative to the first selected pool to switch" summary={sum.tipSwitch}>
        <TipSwitching o={o} members={members} tipBlocks={params.tipBlocks} />
      </Row>
      <Row title="4 · Payouts & merge-mining" caption="shared coinbase outputs and identical merge-mining commitments" summary={sum.payoutsMergeMining}>
        <Payouts o={o} members={members} />
      </Row>
      <div className="border-t border-gray-200 pt-2 text-[10px] text-gray-500 dark:border-gray-800">
        Strength = bits of evidence: −log₂(fraction of observed pools that also showed it), averaged over the selected pairs. A tip change all pools make carries ~0 bits. Bits add across observations (new-tip switching combines its per-block ranks into one figure); this card shows each channel&apos;s total, never a verdict.
      </div>
    </div>
  );
}

export const evidenceCardVisual: VisualDefinition<EvidenceParams> = {
  id: 'evidence-card',
  title: 'Relationship evidence',
  description: 'Four independent evidence channels for a selection of pools, in bits.',
  scopes: ['live', 'range', 'height'],
  defaultParams: { thresholdBits: 16, windowBlocks: 1008, pools: [], tipBlocks: 6 },
  paramsSchema: [
    { key: 'pools', label: 'Pools (empty = default)', kind: 'pools' },
    { key: 'tipBlocks', label: 'Tip rows', kind: 'number', min: 1, max: 24 },
    { key: 'thresholdBits', label: 'Grouping threshold (bits)', kind: 'number', min: 4, max: 64 },
  ],
  Component: function EvidenceCardVisual({ params }) { return <EvidenceCard params={params} />; },
};
