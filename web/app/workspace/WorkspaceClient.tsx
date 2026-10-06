"use client";
import React, { useEffect, useReducer, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ScopeProvider } from '@/lib/templates/ScopeProvider';
import type { Scope } from '@/lib/templates/types';
import { decodeLayout, getVisual, VISUALS } from '@/visuals/registry';
import { encodeLayout, type LayoutItem } from '@/visuals/layout';
import { ParamsForm } from '@/visuals/ParamsForm';
import { DEFAULT_WORKSPACE, keyWorkspace, keyedWsReducer, type WsAction } from '@/visuals/workspaceState';

const BTN = 'rounded border border-gray-300 px-1.5 py-0.5 text-xs hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800';
const INPUT = 'rounded border border-gray-300 bg-white px-1 py-0.5 text-xs dark:border-gray-700 dark:bg-gray-900';
const KIND_LABEL: Record<Scope['kind'], string> = { live: 'Live', height: 'Height', range: 'Range' };

// datetime-local works in local wall time without a zone suffix.
const toLocalInput = (ms: number) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};
const fromLocalInput = (s: string) => { const t = new Date(s).getTime(); return Number.isFinite(t) ? t : null; };

function defaultScope(kind: Scope['kind']): Scope {
  if (kind === 'live') return { kind };
  if (kind === 'height') return { kind, height: 0 };
  const now = Date.now();
  return { kind, fromMs: now - 60 * 60_000, toMs: now };
}

// Commits on Enter/blur so typing a height doesn't load every intermediate prefix.
function HeightInput({ height, onCommit }: { height: number; onCommit: (h: number) => void }) {
  const [draft, setDraft] = useState(height ? String(height) : '');
  const commit = () => { const n = Math.floor(Number(draft)); if (draft !== '' && Number.isFinite(n) && n > 0 && n !== height) onCommit(n); };
  return (
    <input
      aria-label="Block height" type="number" min={1} placeholder="height" className={`${INPUT} w-24`}
      value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); }}
    />
  );
}

function ScopePicker({ scope, kinds, onChange }: { scope: Scope; kinds: Scope['kind'][]; onChange: (s: Scope) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <select aria-label="Scope" className={INPUT} value={scope.kind} onChange={e => onChange(defaultScope(e.target.value as Scope['kind']))}>
        {kinds.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
      </select>
      {scope.kind === 'height' && <HeightInput height={scope.height} onCommit={h => onChange({ kind: 'height', height: h })} />}
      {scope.kind === 'range' && (
        <>
          <input
            aria-label="From" type="datetime-local" className={INPUT} value={toLocalInput(scope.fromMs)}
            onChange={e => { const t = fromLocalInput(e.target.value); if (t !== null && t <= scope.toMs) onChange({ ...scope, fromMs: t }); }}
          />
          <span className="text-xs text-gray-500">–</span>
          <input
            aria-label="To" type="datetime-local" className={INPUT} value={toLocalInput(scope.toMs)}
            onChange={e => { const t = fromLocalInput(e.target.value); if (t !== null && t >= scope.fromMs) onChange({ ...scope, toMs: t }); }}
          />
        </>
      )}
    </div>
  );
}

function Card({ item, index, count, dispatch }: { item: LayoutItem; index: number; count: number; dispatch: React.Dispatch<WsAction> }) {
  const [open, setOpen] = useState(false);
  const def = getVisual(item.v);
  if (!def) return null;
  const Comp = def.Component;
  // A height scope of 0 is a placeholder until the user enters a height.
  const ready = item.s.kind !== 'height' || item.s.height > 0;
  return (
    <section className="min-w-0 rounded border border-gray-200 p-3 dark:border-gray-800">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 pb-2 dark:border-gray-800">
        <h2 className="text-sm font-semibold" title={def.description}>{def.title}</h2>
        <div className="flex flex-wrap items-center gap-1">
          <ScopePicker scope={item.s} kinds={def.scopes} onChange={s => dispatch({ type: 'scope', index, s })} />
          <button type="button" className={BTN} aria-label="Move up" disabled={index === 0} onClick={() => dispatch({ type: 'move', index, dir: -1 })}>↑</button>
          <button type="button" className={BTN} aria-label="Move down" disabled={index === count - 1} onClick={() => dispatch({ type: 'move', index, dir: 1 })}>↓</button>
          <button type="button" className={BTN} aria-label="Parameters" aria-pressed={open} onClick={() => setOpen(o => !o)}>⚙</button>
          <button type="button" className={BTN} aria-label="Remove" onClick={() => dispatch({ type: 'remove', index })}>✕</button>
        </div>
      </header>
      {ready ? (
        <ScopeProvider scope={item.s}>
          {open && (
            <div className="mt-2 rounded bg-gray-50 p-2 dark:bg-gray-900">
              <ParamsForm schema={def.paramsSchema} params={item.p} onChange={p => dispatch({ type: 'params', index, p })} />
            </div>
          )}
          <Comp scope={item.s} params={item.p} />
        </ScopeProvider>
      ) : (
        <div className="mt-3 text-[11px] italic text-gray-500">enter a block height</div>
      )}
    </section>
  );
}

export default function WorkspaceClient() {
  const searchParams = useSearchParams();
  // ?l= is read once on mount; later URL changes are ours (mirrored below), not inputs.
  const [{ items, ids }, dispatch] = useReducer(keyedWsReducer, undefined, () => {
    const decoded = decodeLayout(searchParams.get('l'));
    return keyWorkspace(decoded.length ? decoded : DEFAULT_WORKSPACE);
  });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Mirror every change into the URL; on first render this also normalises a garbage or clamped ?l=.
    // history.replaceState avoids a soft navigation (RSC fetch) per edit; Next keeps useSearchParams in sync.
    window.history.replaceState(window.history.state, '', '/workspace?l=' + encodeLayout(items));
  }, [items]);

  const add = (id: string) => {
    const def = getVisual(id);
    if (def) dispatch({ type: 'add', item: { v: def.id, s: { kind: 'live' }, p: { ...(def.defaultParams as Record<string, unknown>) } } });
  };
  const copy = () => {
    void navigator.clipboard.writeText(location.href).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => { /* clipboard denied: URL bar still has the link */ });
  };

  return (
    <main className="mx-auto flex max-w-[1800px] flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Add visual" className={INPUT} value="" onChange={e => { add(e.target.value); e.target.value = ''; }}>
          <option value="">Add visual…</option>
          {VISUALS.map(v => <option key={v.id} value={v.id}>{v.title}</option>)}
        </select>
        <button type="button" className={BTN} onClick={copy}>{copied ? 'copied' : 'Copy link'}</button>
        <button type="button" className={BTN} onClick={() => dispatch({ type: 'replace', items: DEFAULT_WORKSPACE })}>Reset</button>
      </div>
      {items.length === 0 ? (
        <div className="text-[11px] italic text-gray-500">no visuals; add one above</div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {items.map((it, i) => (
            <Card key={ids[i]} item={it} index={i} count={items.length} dispatch={dispatch} />
          ))}
        </div>
      )}
    </main>
  );
}
