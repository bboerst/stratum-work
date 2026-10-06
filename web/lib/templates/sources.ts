import type { BlockData } from '@/lib/types';
import { parsePoolDefs } from './identify';
import { runIdleChunks } from './idle';
import type { TemplateStore } from './store';
import type { RawTemplate, RoutingStatus } from './types';

export interface SourceDeps { fetch: typeof fetch; EventSource: new (url: string) => EventSource; now: () => number }
export const browserDeps = (): SourceDeps => ({ fetch: (...a) => fetch(...a), EventSource, now: Date.now });

const LIVE_WINDOW_MS = 60 * 60_000;
const BATCH_MS = 250;

export type StreamMessage =
  | { kind: 'template'; raw: RawTemplate }
  | { kind: 'block'; block: BlockData }
  | { kind: 'routing'; routing: RoutingStatus }
  | { kind: 'resync'; since: number; cursor: number }
  | { kind: 'ignore' };

export function classifyStreamMessage(j: unknown): StreamMessage {
  if (!j || typeof j !== 'object') return { kind: 'ignore' };
  const o = j as Record<string, unknown>;
  if (typeof o.pool_name === 'string' && typeof o.prev_hash === 'string') return { kind: 'template', raw: o as unknown as RawTemplate };
  if (o.type === 'block' && o.data && typeof o.data === 'object') return { kind: 'block', block: o.data as BlockData };
  if (o.type === 'routing' && typeof o.site === 'string') return { kind: 'routing', routing: o as unknown as RoutingStatus };
  if (o.type === 'resync') return { kind: 'resync', since: Number(o.since), cursor: Number(o.cursor) };
  return { kind: 'ignore' };
}

const trim = (s: string) => s.replace(/\/+$/, '');

export function streamUrl(endpoint: string, after: number): string {
  return `${trim(endpoint)}/stream?view=all&after=${after}`;
}

async function getJson(deps: SourceDeps, url: string): Promise<unknown> {
  const r = await deps.fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

export async function loadPools(store: TemplateStore, deps: SourceDeps): Promise<void> {
  try { store.setPools(parsePoolDefs(await getJson(deps, '/api/pools'))); }
  catch { store.setPools([]); store.setStatus({ poolsUnavailable: true }); }
}

export async function loadBlocks(store: TemplateStore, deps: SourceDeps, n = 1008): Promise<void> {
  try {
    const j = await getJson(deps, `/api/blocks?n=${n}`) as { blocks?: BlockData[] };
    store.ingestBlocks(j.blocks ?? []);
  } catch { store.setStatus({ blocksUnavailable: true }); }
}

const BACKFILL_TIMEOUT_MS = 15_000;

/**
 * `/templates` must answer JSON promptly. A legacy stream server answers unknown paths with an endless
 * `text/event-stream`, whose `json()` would never settle and block going live, so reject other content types
 * and abort after BACKFILL_TIMEOUT_MS.
 */
async function getTemplatesJson(deps: SourceDeps, url: string): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), BACKFILL_TIMEOUT_MS);
  try {
    const r = await deps.fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    const type = r.headers?.get('content-type') ?? '';
    if (!type.includes('application/json')) { ac.abort(); throw new Error(`${url}: unexpected content-type ${type || '(none)'}`); }
    return await r.json();
  } finally { clearTimeout(timer); }
}

async function backfill(store: TemplateStore, base: string, since: number, deps: SourceDeps, live: () => boolean = () => true): Promise<number> {
  const j = await getTemplatesJson(deps, `${trim(base)}/templates?since=${since}&view=all`) as { items?: RawTemplate[]; cursor?: number };
  await runIdleChunks(j.items ?? [], b => { if (live()) store.ingest(b); });
  return typeof j.cursor === 'number' ? j.cursor : deps.now();
}

export function startLive(store: TemplateStore, cfg: { streamEndpoint: string; templatesEndpoint: string }, deps: SourceDeps): () => void {
  let stopped = false;
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let buf: RawTemplate[] = [];
  const live = () => !stopped;
  void loadPools(store, deps);
  void loadBlocks(store, deps);
  // Without a stream service there is nothing to follow: history is unavailable and the store stays disconnected.
  if (!cfg.streamEndpoint.trim()) {
    store.setStatus({ historyUnavailable: true, connected: false });
    return () => { stopped = true; };
  }
  void (async () => {
    let cursor = deps.now();
    if (cfg.templatesEndpoint) {
      try { cursor = await backfill(store, cfg.templatesEndpoint, deps.now() - LIVE_WINDOW_MS, deps); }
      catch { store.setStatus({ historyUnavailable: true }); }
    } else store.setStatus({ historyUnavailable: true });
    if (stopped) return;
    es = new deps.EventSource(streamUrl(cfg.streamEndpoint, cursor));
    es.onopen = () => store.setStatus({ connected: true });
    es.onerror = () => store.setStatus({ connected: false }); // EventSource reconnects itself with Last-Event-ID
    es.onmessage = (e: MessageEvent<string>) => {
      let j: unknown;
      try { j = JSON.parse(e.data); } catch { return; }
      const m = classifyStreamMessage(j);
      if (m.kind === 'template') buf.push(m.raw);
      else if (m.kind === 'block') store.ingestBlocks([m.block], 'stream');
      else if (m.kind === 'routing') store.ingestRouting(m.routing);
      else if (m.kind === 'resync') {
        if (!cfg.templatesEndpoint) store.setStatus({ historyUnavailable: true });
        else void backfill(store, cfg.templatesEndpoint, m.since, deps, live)
          .catch(() => { if (live()) store.setStatus({ historyUnavailable: true }); });
      }
    };
    timer = setInterval(() => { if (buf.length) { const b = buf; buf = []; store.ingest(b); } }, BATCH_MS);
  })();
  return () => {
    stopped = true;
    es?.close();
    if (timer) clearInterval(timer);
    if (buf.length) { const b = buf; buf = []; store.ingest(b); }
  };
}

export async function loadHeight(store: TemplateStore, height: number, deps: SourceDeps): Promise<void> {
  void loadPools(store, deps);
  try {
    const items = await getJson(deps, `/api/mining-notify?height=${height}`) as RawTemplate[];
    await runIdleChunks(Array.isArray(items) ? items : [], b => { store.ingest(b); });
  } catch { store.setStatus({ historyUnavailable: true }); }
  try {
    const j = await getJson(deps, `/api/blocks?height=${height}&n=10`) as { blocks?: BlockData[] };
    store.ingestBlocks(j.blocks ?? []);
  } catch { store.setStatus({ blocksUnavailable: true }); }
}

export async function loadRange(store: TemplateStore, fromMs: number, toMs: number, deps: SourceDeps): Promise<void> {
  void loadPools(store, deps);
  try {
    const j = await getJson(deps, `/api/history?from=${fromMs}&to=${toMs}`) as { items?: RawTemplate[] };
    await runIdleChunks(j.items ?? [], b => { store.ingest(b); });
  } catch { store.setStatus({ historyUnavailable: true }); }
}
