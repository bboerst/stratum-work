"use client";
import React, { createContext, useEffect, useMemo } from 'react';
import { TemplateStore } from './store';
import { browserDeps, loadHeight, loadRange, startLive } from './sources';
import type { Scope } from './types';

export const ScopeStoreContext = createContext<TemplateStore | null>(null);

const LIVE_RETENTION_MS = 60 * 60_000;

// One live store per page load, shared by every live-scope consumer (and the legacy DataStreamContext adapter).
// It is never discarded: when the last consumer unmounts only the source stops; retention trims stale data on restart.
let liveStore: TemplateStore | null = null;
let liveStop: (() => void) | null = null;
let liveUsers = 0;

async function runtimeConfig(): Promise<{ streamEndpoint?: string; templatesEndpoint?: string }> {
  try {
    const r = await fetch('/api/runtime-config', { cache: 'no-store' });
    return await r.json() as { streamEndpoint?: string; templatesEndpoint?: string };
  } catch { return {}; }
}

export function getLiveStore(): TemplateStore {
  if (!liveStore) liveStore = new TemplateStore({ retentionMs: LIVE_RETENTION_MS });
  return liveStore;
}

export function ScopeProvider({ scope, children }: { scope: Scope; children: React.ReactNode }) {
  const key = JSON.stringify(scope);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const store = useMemo(() => (scope.kind === 'live' ? getLiveStore() : new TemplateStore({ retentionMs: null })), [key]);
  useEffect(() => {
    const deps = browserDeps();
    if (scope.kind === 'live') {
      liveUsers++;
      if (!liveStop) {
        let cancelled = false;
        let stop: (() => void) | null = null;
        liveStop = () => { cancelled = true; stop?.(); };
        void runtimeConfig().then(c => {
          if (cancelled) return;
          stop = startLive(store, { streamEndpoint: c.streamEndpoint || '', templatesEndpoint: c.templatesEndpoint || '' }, deps);
        });
      }
      return () => {
        liveUsers--;
        if (liveUsers === 0) { liveStop?.(); liveStop = null; store.setStatus({ connected: false }); }
      };
    }
    // Frozen scopes: results that land after unmount are dropped by never settling the fetch, rather than
    // rejecting it, which would flag the store as unavailable. StrictMode remounts reuse the same store.
    let cancelled = false;
    const guarded: typeof deps = { ...deps, fetch: (async (...a: Parameters<typeof fetch>) => {
      const r = await deps.fetch(...a);
      return cancelled ? new Promise<never>(() => {}) : r;
    }) as typeof fetch };
    if (scope.kind === 'height') void loadHeight(store, scope.height, guarded);
    else void loadRange(store, scope.fromMs, scope.toMs, guarded);
    return () => { cancelled = true; };
  }, [store]); // eslint-disable-line react-hooks/exhaustive-deps
  return <ScopeStoreContext.Provider value={store}>{children}</ScopeStoreContext.Provider>;
}
