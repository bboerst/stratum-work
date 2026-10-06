import type { Scope } from '@/lib/templates/types';
import type { ParamField } from './types';

export interface LayoutItem { v: string; s: Scope; p: Record<string, unknown> }
type Lookup = (id: string) => { defaultParams: unknown; scopes: string[]; paramsSchema?: ParamField[] } | undefined;

const b64u = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

export const encodeLayout = (items: LayoutItem[]) => b64u(JSON.stringify(items));

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Returns a clean Scope, or null when the kind is unknown or its fields are invalid. */
function parseScope(s: unknown): Scope | null {
  if (!s || typeof s !== 'object') return null;
  const o = s as Record<string, unknown>;
  if (o.kind === 'live') return { kind: 'live' };
  if (o.kind === 'height') return fin(o.height) ? { kind: 'height', height: o.height } : null;
  if (o.kind === 'range') return fin(o.fromMs) && fin(o.toMs) && o.fromMs <= o.toMs ? { kind: 'range', fromMs: o.fromMs, toMs: o.toMs } : null;
  return null;
}

/** Merge `p` over defaults; numeric schema fields are clamped to min/max, non-finite values fall back to the default. */
function mergeParams(defaults: Record<string, unknown>, p: Record<string, unknown>, schema: ParamField[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = { ...defaults, ...p };
  for (const f of schema) {
    if (f.kind !== 'number') continue;
    const v = out[f.key];
    if (!fin(v)) { out[f.key] = defaults[f.key]; continue; }
    out[f.key] = Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, v));
  }
  return out;
}

export function decodeLayoutWith(s: string | null, lookup: Lookup): LayoutItem[] {
  if (!s) return [];
  let raw: unknown;
  try { raw = JSON.parse(unb64u(s)); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out: LayoutItem[] = [];
  for (const it of raw as Array<Partial<LayoutItem> | null>) {
    const def = it && typeof it.v === 'string' ? lookup(it.v) : undefined;
    const scope = it ? parseScope(it.s) : null;
    if (!it || !def || !scope || !def.scopes.includes(scope.kind)) continue;
    const p = it.p && typeof it.p === 'object' && !Array.isArray(it.p) ? it.p : {};
    out.push({ v: it.v!, s: scope, p: mergeParams(def.defaultParams as Record<string, unknown>, p, def.paramsSchema) });
  }
  return out;
}
