"use client";
import React, { useId } from 'react';
import { useTemplates } from '@/lib/templates/hooks';
import type { ParamField } from './types';

const INPUT = 'rounded border border-gray-300 bg-white px-1 py-0.5 text-xs dark:border-gray-700 dark:bg-gray-900';

/** Must render inside the item's ScopeProvider so pool lists come from that scope. */
export function ParamsForm({ schema, params, onChange }: { schema: ParamField[]; params: Record<string, unknown>; onChange: (p: Record<string, unknown>) => void }) {
  const uid = useId();
  const pools = useTemplates(s => s.poolNames());
  const set = (k: string, v: unknown) => onChange({ ...params, [k]: v });
  if (!schema.length) return <div className="text-[11px] italic text-gray-500">no parameters</div>;
  return (
    <div className="flex flex-col gap-2 text-xs">
      {schema.map(f => {
        const id = `${uid}-${f.key}`;
        if (f.kind === 'number') {
          return (
            <label key={f.key} htmlFor={id} className="flex items-center justify-between gap-2">
              <span>{f.label}</span>
              <input
                id={id} type="number" className={`${INPUT} w-20`} min={f.min} max={f.max} step={f.step}
                value={typeof params[f.key] === 'number' ? (params[f.key] as number) : ''}
                onChange={e => {
                  const n = e.target.valueAsNumber;
                  if (!Number.isFinite(n)) return;
                  set(f.key, Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, n)));
                }}
              />
            </label>
          );
        }
        if (f.kind === 'select' || f.kind === 'pool') {
          const opts = f.kind === 'select' ? f.options : [{ value: '', label: '(default)' }].concat(pools.map(p => ({ value: p, label: p })));
          return (
            <label key={f.key} htmlFor={id} className="flex items-center justify-between gap-2">
              <span>{f.label}</span>
              <select id={id} className={INPUT} value={String(params[f.key] ?? '')} onChange={e => set(f.key, e.target.value)}>
                {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          );
        }
        const cur = Array.isArray(params[f.key]) ? (params[f.key] as string[]) : [];
        return (
          <fieldset key={f.key}>
            <legend className="mb-1">{f.label}</legend>
            {pools.length === 0 ? <span className="text-[11px] italic text-gray-500">no pools in scope</span> : (
              <div className="grid max-h-40 grid-cols-2 gap-x-2 overflow-y-auto">
                {pools.map(p => (
                  <label key={p} className="flex items-center gap-1 truncate" title={p}>
                    <input
                      type="checkbox" checked={cur.includes(p)}
                      onChange={e => set(f.key, e.target.checked ? cur.concat([p]) : cur.filter(x => x !== p))}
                    />
                    {p}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        );
      })}
    </div>
  );
}
