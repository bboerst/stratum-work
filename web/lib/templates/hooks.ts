"use client";
import { useCallback, useContext, useMemo, useRef, useSyncExternalStore } from 'react';
import type { BlockData } from '@/lib/types';
import { ScopeStoreContext } from './ScopeProvider';
import type { StoreSnapshot, TemplateStore } from './store';
import type { RoutingStatus } from './types';

export function useScopeStore(): TemplateStore {
  const s = useContext(ScopeStoreContext);
  if (!s) throw new Error('useScopeStore must be used inside <ScopeProvider>');
  return s;
}

export function useStoreSnapshot(): StoreSnapshot {
  const store = useScopeStore();
  const subscribe = useCallback((fn: () => void) => store.subscribe(fn), [store]);
  const get = useCallback(() => store.getSnapshot(), [store]);
  return useSyncExternalStore(subscribe, get, get);
}

export function useTemplates<T>(sel: (s: TemplateStore) => T): T {
  const store = useScopeStore();
  const snap = useStoreSnapshot(); // a new snapshot object per store version
  const selRef = useRef(sel);
  selRef.current = sel;
  return useMemo(() => { void snap; return selRef.current(store); }, [store, snap]);
}

export function useBlocks(): BlockData[] {
  // The blocks Map is mutated in place, so memoize on the snapshot (new object per version), not the Map.
  const snap = useStoreSnapshot();
  return useMemo(() => Array.from(snap.blocks.values()).sort((a, b) => b.height - a.height), [snap]);
}

export function useRouting(): RoutingStatus[] {
  const snap = useStoreSnapshot();
  return useMemo(() => Array.from(snap.routing.values()), [snap]);
}

export function useStoreStatus(): StoreSnapshot['status'] {
  return useStoreSnapshot().status;
}

// Cross-component cache: several visuals calling useAnalysis(fn, params) with equal
// (store, version, params) share one computation. At most ANALYSIS_CACHE_MAX entries per fn.
type AnalysisFn = (store: TemplateStore, params: never) => unknown;
const ANALYSIS_CACHE_MAX = 4;
const analysisCache = new WeakMap<TemplateStore, Map<AnalysisFn, { version: number; key: string; value: unknown }[]>>();

function cachedAnalysis<P, R>(store: TemplateStore, version: number, fn: (store: TemplateStore, params: P) => R, params: P, key: string): R {
  let byFn = analysisCache.get(store);
  if (!byFn) { byFn = new Map(); analysisCache.set(store, byFn); }
  const f = fn as unknown as AnalysisFn;
  const entries = (byFn.get(f) ?? []).filter(e => e.version === version);
  const hit = entries.find(e => e.key === key);
  if (hit) return hit.value as R;
  const value = fn(store, params);
  entries.push({ version, key, value });
  byFn.set(f, entries.slice(-ANALYSIS_CACHE_MAX));
  return value;
}

/** Memoized on (store version, JSON.stringify(params)) per component and across components sharing `fn`. */
export function useAnalysis<P, R>(fn: (store: TemplateStore, params: P) => R, params: P): R {
  const store = useScopeStore();
  const snap = useStoreSnapshot();
  const key = JSON.stringify(params);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const paramsRef = useRef(params);
  paramsRef.current = params;
  return useMemo(() => cachedAnalysis(store, snap.version, fnRef.current, paramsRef.current, key), [store, snap, key]); // keyed on serialized params by design
}
