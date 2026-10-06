import http from 'node:http';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import type { MessageKind, RawMessage } from './message.js';
import { RingBuffer } from './ring.js';
import { PoolViewReducer } from './poolView.js';
import { SseClient } from './sse.js';
import { m, registry } from './metrics.js';

const gzip = promisify(zlib.gzip);

export interface OutEvent { rx: number; views: { all: boolean; pool: boolean; legacy: boolean }; msg: RawMessage; poolBody?: string }
export interface RingItem { rx: number; mid: string; kind: MessageKind; body: string }
export type IngestSource = 'broker' | 'warmup';

const slim = (msg: RawMessage, body = msg.body, kind = msg.kind): RingItem => ({ rx: msg.rx, mid: msg.mid, kind, body });

export class StreamState {
  ring: RingBuffer<RingItem>; poolRing: RingBuffer<RingItem>; legacyRing: RingBuffer<RingItem>;
  private reducer = new PoolViewReducer();
  private subs = new Set<(ev: OutEvent) => void>();
  private lastBySite = new Map<string, number>();
  private newestRx = -Infinity;
  constructor(private opts: { historyMinutes: number; blacklist: (p?: string | null) => boolean }) {
    const age = opts.historyMinutes * 60_000;
    this.ring = new RingBuffer(age); this.poolRing = new RingBuffer(age); this.legacyRing = new RingBuffer(age);
  }
  subscribe(fn: (ev: OutEvent) => void) { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  ingest(msg: RawMessage, source: IngestSource = 'broker') {
    m.messages.inc({ kind: msg.kind, source });
    if (msg.kind === 'share' || msg.kind === 'other') return;
    if (msg.kind === 'template' && this.opts.blacklist(msg.pool)) return;
    if (msg.kind === 'template' && msg.site) this.lastBySite.set(msg.site, Math.max(this.lastBySite.get(msg.site) ?? -Infinity, msg.rx));
    // Legacy forwards every observe template undeduplicated: fork-observer expires pools not seen for 120 s.
    const views = { all: true, pool: true, legacy: msg.kind === 'block' || (msg.kind === 'template' && msg.mode !== 'work') };
    let poolBody = msg.body, poolKind: MessageKind = msg.kind;
    if (msg.kind === 'template') {
      const r = this.reducer.accept(msg);
      if (!r.emit) {
        const a = r.arrival!;
        poolBody = JSON.stringify({ type: 'arrival', mid: a.mid, connection_id: a.connectionId, rx: a.rx, first_mid: a.firstMid });
        poolKind = 'other';
      }
    }
    const item = slim(msg);
    this.ring.push(item);
    this.poolRing.push(poolBody === msg.body ? item : slim(msg, poolBody, poolKind));
    if (views.legacy) this.legacyRing.push(item);
    const now = Date.now();
    this.newestRx = Math.max(this.newestRx, msg.rx);
    // Evict relative to the newest item (capped at wall clock) so a skewed-future rx cannot flush the rings.
    const horizon = Math.min(now, this.newestRx);
    for (const r of [this.ring, this.poolRing, this.legacyRing]) r.evict(horizon);
    m.ringItems.set(this.ring.size());
    const oldest = this.ring.oldestRx(); if (oldest !== undefined) m.ringOldestAge.set((now - oldest) / 1000);
    const ev: OutEvent = { rx: msg.rx, views, msg, poolBody };
    for (const fn of this.subs) fn(ev);
  }
  updatePublisherAges() { const now = Date.now(); for (const [site, t] of this.lastBySite) m.publisherAge.set({ site }, (now - t) / 1000); }
}

export interface ServerOpts { replayOverlapMs: number; maxBufferBytes: number; heartbeatMs: number; isReady: () => boolean; sseGzip?: boolean }
export type StreamServer = http.Server & { drain: (drainMs: number) => Promise<void> };

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
const LEGACY_GREETING = '{"type":"connection","status":"connected"}';
const DRAIN_STEPS = 20;
const REPLAY_FRAME_OVERHEAD = 24;
const SSE_HEADERS = { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' };
const retryJitterMs = () => 1000 + Math.floor(Math.random() * 4001);
const acceptsGzip = (req: http.IncomingMessage) => /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));

function finiteOrUndefined(v: unknown): number | undefined {
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function createServer(state: StreamState, opts: ServerOpts): StreamServer {
  const clients = new Set<SseClient>();
  const hb = setInterval(() => clients.forEach(c => c.comment('')), opts.heartbeatMs); hb.unref();

  function openSse(req: http.IncomingMessage, res: http.ServerResponse, allowGzip: boolean) {
    const headers: Record<string, string> = { ...SSE_HEADERS };
    let gz: zlib.Gzip | undefined;
    if (allowGzip && opts.sseGzip && acceptsGzip(req)) {
      Object.assign(headers, { 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
      gz = zlib.createGzip();
      gz.pipe(res);
    }
    res.writeHead(200, headers);
    res.flushHeaders();
    const client = new SseClient(res, {
      maxBufferBytes: opts.maxBufferBytes, gzip: gz,
      onDrop: (reason) => { clients.delete(client); m.disconnects.inc({ reason }); m.activeConnections.set(clients.size); },
    });
    clients.add(client); m.activeConnections.set(clients.size);
    return client;
  }

  // EventSource treats any non-200 as fatal, so an unready pod hands out a retry hint instead of 503.
  function refuseSse(res: http.ServerResponse) {
    res.writeHead(200, SSE_HEADERS);
    res.end(`retry: ${retryJitterMs()}\n\n`);
    m.disconnects.inc({ reason: 'refused' });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    if (req.method !== 'GET') { res.writeHead(405, CORS); res.end(); return; }
    const view = url.searchParams.get('view') === 'all' ? 'all' : 'pool';

    if (url.pathname === '/') {
      if (!opts.isReady()) { refuseSse(res); return; }
      const c = openSse(req, res, false);
      c.send(LEGACY_GREETING);
      const unsub = state.subscribe(ev => { if (ev.views.legacy) c.send(ev.msg.body); });
      res.on('close', unsub);
      return;
    }
    if (url.pathname === '/stream') {
      if (!opts.isReady()) { refuseSse(res); return; }
      const c = openSse(req, res, true);
      const cursors = [finiteOrUndefined(url.searchParams.get('after')), finiteOrUndefined(req.headers['last-event-id'])].filter((n): n is number => n !== undefined);
      const after = cursors.length ? Math.max(...cursors) : Date.now();
      const ring = view === 'all' ? state.ring : state.poolRing;
      const from = after - opts.replayOverlapMs;
      const replay = ring.since(from);
      let bytes = 0;
      for (const msg of replay) { bytes += msg.body.length + REPLAY_FRAME_OVERHEAD; if (bytes > opts.maxBufferBytes / 2) break; }
      if (bytes > opts.maxBufferBytes / 2) {
        // Too large to replay without tripping the slow-client bound: tell the client to backfill the gap from
        // /templates and move its Last-Event-ID forward so automatic reconnects do not repeat the oversized replay.
        const cursor = replay[replay.length - 1].rx;
        c.send(JSON.stringify({ type: 'resync', since: from, cursor }), cursor);
        m.replayResyncs.inc();
      } else {
        for (const msg of replay) c.send(msg.body, msg.rx);
      }
      const unsub = state.subscribe(ev => { if (ev.views[view]) c.send(view === 'all' ? ev.msg.body : ev.poolBody!, ev.rx); });
      res.on('close', unsub);
      return;
    }
    if (url.pathname === '/templates') {
      if (!opts.isReady()) { res.writeHead(503, { ...CORS, 'Retry-After': '5' }); res.end(); return; }
      const since = Math.floor((finiteOrUndefined(url.searchParams.get('since')) ?? 0) / 10_000) * 10_000;
      const ring = view === 'all' ? state.ring : state.poolRing;
      const items = ring.since(since - 1);
      const body = `{"items":[${items.map(i => i.body).join(',')}],"cursor":${items.length ? items[items.length - 1].rx : since}}`;
      const headers: Record<string, string> = { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10', 'Vary': 'Accept-Encoding' };
      if (acceptsGzip(req)) { const z = await gzip(body); res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' }); res.end(z); }
      else { res.writeHead(200, headers); res.end(body); }
      return;
    }
    if (url.pathname === '/healthz/live') { res.writeHead(200, CORS); res.end('ok'); return; }
    if (url.pathname === '/healthz/ready') { const ok = opts.isReady(); res.writeHead(ok ? 200 : 503, CORS); res.end(ok ? 'ok' : 'not ready'); return; }
    if (url.pathname === '/metrics') { state.updatePublisherAges(); res.writeHead(200, { ...CORS, 'Content-Type': registry.contentType }); res.end(await registry.metrics()); return; }
    res.writeHead(404, CORS); res.end();
  }) as StreamServer;
  server.on('close', () => clearInterval(hb));

  server.drain = async (drainMs: number) => {
    const list = [...clients];
    const step = Math.max(1, Math.ceil(list.length / DRAIN_STEPS));
    for (let i = 0; i < list.length; i += step) {
      list.slice(i, i + step).forEach(c => { c.retry(retryJitterMs()); c.close(); });
      await new Promise(r => setTimeout(r, drainMs / DRAIN_STEPS));
    }
  };
  return server;
}
