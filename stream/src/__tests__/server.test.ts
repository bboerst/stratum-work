import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import zlib from 'node:zlib';
import { StreamState, createServer, type ServerOpts } from '../server.js';
import { toRawMessage } from '../message.js';

let server: http.Server & { drain: (ms: number) => Promise<void> }; let base: string; let state: StreamState;
let ready = true;
const tpl = (o: Record<string, unknown>) => JSON.stringify({ pool_name: 'A', height: 1, prev_hash: 'p', coinbase1: 'a', coinbase2: 'b', merkle_branches: [], version: 'v', nbits: 'n', ntime: 't', clean_jobs: false, job_id: 'j', timestamp: '1', ...o });

async function start(extra: Partial<ServerOpts> = {}) {
  server = createServer(state, { replayOverlapMs: 5000, maxBufferBytes: 1 << 20, heartbeatMs: 60_000, isReady: () => ready, ...extra });
  await new Promise<void>(r => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  ready = true;
  state = new StreamState({ historyMinutes: 60, blacklist: (p) => p === 'Blocked' });
  await start();
});
afterEach(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));

async function readSse(path: string, n: number, headers: Record<string, string> = {}): Promise<{ headers: Headers; events: string[]; raw: string }> {
  const ctrl = new AbortController();
  const res = await fetch(base + path, { signal: ctrl.signal, headers });
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ''; let raw = ''; const events: string[] = [];
  while (events.length < n) {
    const { value, done } = await reader.read(); if (done) break;
    const s = dec.decode(value, { stream: true }); raw += s; buf += s;
    let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); if (!chunk.startsWith(':')) events.push(chunk); }
  }
  ctrl.abort();
  return { headers: res.headers, events, raw };
}

const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));

describe('stream server', () => {
  it('legacy root sends the connection greeting first, with CORS *', async () => {
    const p = readSse('/', 2);
    await tick();
    state.ingest(toRawMessage(Buffer.from(tpl({})), Date.now())!);
    const { headers, events } = await p;
    expect(headers.get('access-control-allow-origin')).toBe('*');
    expect(headers.get('content-type')).toContain('text/event-stream');
    expect(events[0]).toBe('data: {"type":"connection","status":"connected"}');
    expect(events[1]).toContain('"pool_name":"A"');
  });
  it('legacy root frames events exactly like the old endpoint and replays nothing', async () => {
    const old = tpl({ job_id: 'old' });
    state.ingest(toRawMessage(Buffer.from(old), Date.now() - 1000)!);
    const p = readSse('/', 3, { 'Accept-Encoding': 'gzip' });
    await tick();
    const body = tpl({ job_id: 'x', prev_hash: 'q' });
    const block = JSON.stringify({ type: 'block', id: 'h', timestamp: 'x', data: { hash: 'h', height: 2 } });
    state.ingest(toRawMessage(Buffer.from(body), Date.now())!);
    state.ingest(toRawMessage(Buffer.from(block), Date.now())!);
    const { headers, raw } = await p;
    expect(headers.get('content-encoding')).toBeNull();
    expect(raw).toBe(`data: {"type":"connection","status":"connected"}\n\ndata: ${body}\n\ndata: ${block}\n\n`);
  });
  it('/stream replays from after minus overlap with ids', async () => {
    state.ingest(toRawMessage(Buffer.from(tpl({ job_id: '1' })), 1000)!);
    state.ingest(toRawMessage(Buffer.from(tpl({ job_id: '2', prev_hash: 'q' })), 20000)!);
    const { events } = await readSse('/stream?after=12000&view=all', 1);
    expect(events[0]).toMatch(/^id: 20000\ndata: /);
  });
  it('/stream replay includes items within the overlap window', async () => {
    state.ingest(toRawMessage(Buffer.from(tpl({ job_id: '1' })), 8000)!);
    const { events } = await readSse('/stream?after=12000&view=all', 1);
    expect(events[0]).toMatch(/^id: 8000\n/);
  });
  it('answers a replay larger than the client buffer with a resync event instead of dropping the client', async () => {
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    await start({ maxBufferBytes: 4096 });
    const t0 = Date.now() - 60_000;
    for (let i = 0; i < 50; i++) state.ingest(toRawMessage(Buffer.from(tpl({ job_id: String(i), prev_hash: 'p' + i, coinbase1: 'x'.repeat(200) })), t0 + i)!);
    const p = readSse(`/stream?after=${t0 - 10_000}&view=all`, 2);
    await tick();
    const live = tpl({ job_id: 'live', prev_hash: 'live' });
    state.ingest(toRawMessage(Buffer.from(live), Date.now())!);
    const { events } = await p;
    expect(events[0]).toBe(`id: ${t0 + 49}\ndata: ${JSON.stringify({ type: 'resync', since: t0 - 15_000, cursor: t0 + 49 })}`);
    expect(events[1]).toContain('"job_id":"live"');
  });
  it('replays normally when the replay fits within half the client buffer', async () => {
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    await start({ maxBufferBytes: 1 << 20 });
    const t0 = Date.now() - 60_000;
    for (let i = 0; i < 50; i++) state.ingest(toRawMessage(Buffer.from(tpl({ job_id: String(i), prev_hash: 'p' + i, coinbase1: 'x'.repeat(200) })), t0 + i)!);
    const { events } = await readSse(`/stream?after=${t0 - 10_000}&view=all`, 50);
    expect(events).toHaveLength(50);
    expect(events[49]).toMatch(new RegExp(`^id: ${t0 + 49}\n`));
  });
  it('Last-Event-ID resumes', async () => {
    state.ingest(toRawMessage(Buffer.from(tpl({ job_id: '2', prev_hash: 'q' })), 20000)!);
    const { events } = await readSse('/stream?view=all', 1, { 'Last-Event-ID': '12000' });
    expect(events[0]).toContain('id: 20000');
  });
  it('Last-Event-ID wins over a stale after= on automatic reconnect', async () => {
    state.ingest(toRawMessage(Buffer.from(tpl({ job_id: '1' })), 1000)!);
    state.ingest(toRawMessage(Buffer.from(tpl({ job_id: '2', prev_hash: 'q' })), 20000)!);
    const { events } = await readSse('/stream?after=0&view=all', 1, { 'Last-Event-ID': '20000' });
    expect(events[0]).toMatch(/^id: 20000\n/);
  });
  it('/stream view=pool sends arrival records instead of duplicate content, and routing but never shares', async () => {
    const p = readSse('/stream', 3);
    await tick();
    const now = Date.now();
    const first = toRawMessage(Buffer.from(tpl({ connection_id: 's1/A', site: 's1' })), now)!;
    state.ingest(first);
    state.ingest(toRawMessage(Buffer.from(JSON.stringify({ type: 'share', pool_name: 'A', connection_id: 's1/A', timestamp: '1' })), now)!);
    const second = toRawMessage(Buffer.from(tpl({ connection_id: 's2/A', site: 's2' })), now + 1)!;
    state.ingest(second);
    state.ingest(toRawMessage(Buffer.from(JSON.stringify({ type: 'routing', site: 's1', timestamp: '1' })), now + 2)!);
    const { events } = await p;
    expect(events[0]).toBe(`id: ${now}\ndata: ${first.body}`);
    const arrival = JSON.parse(events[1].split('data: ')[1]);
    expect(arrival).toEqual({ type: 'arrival', mid: second.mid, connection_id: 's2/A', rx: now + 1, first_mid: first.mid });
    expect(events[2]).toContain('"type":"routing"');
  });
  it('blacklisted pools are dropped', async () => {
    state.ingest(toRawMessage(Buffer.from(tpl({ pool_name: 'Blocked' })), 1)!);
    const res = await fetch(base + '/templates?since=0&view=all');
    expect((await res.json()).items).toEqual([]);
  });
  it('/templates is cacheable and rounds since to 10 s', async () => {
    state.ingest(toRawMessage(Buffer.from(tpl({})), 15_000)!);
    const res = await fetch(base + '/templates?since=19999&view=all');
    expect(res.headers.get('cache-control')).toBe('public, max-age=10');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const json = await res.json();
    expect(json.items).toHaveLength(1);
    expect(json.cursor).toBe(15_000);
  });
  it('/templates gzips when accepted', async () => {
    state.ingest(toRawMessage(Buffer.from(tpl({})), 15_000)!);
    const { headers, body } = await new Promise<{ headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      http.get(base + '/templates?since=0', { headers: { 'Accept-Encoding': 'gzip' } }, res => {
        const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
    expect(headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(zlib.gunzipSync(body).toString()).items).toHaveLength(1);
  });
  it('OPTIONS preflight returns 204 with CORS', async () => {
    const res = await fetch(base + '/stream', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
  });
  it('ready probe reflects readiness', async () => {
    expect((await fetch(base + '/healthz/ready')).status).toBe(200);
    ready = false;
    expect((await fetch(base + '/healthz/ready')).status).toBe(503);
    expect((await fetch(base + '/healthz/live')).status).toBe(200);
  });
  it('while not ready, SSE routes send only a retry hint (EventSource reconnects) and /templates is 503', async () => {
    ready = false;
    for (const p of ['/', '/stream']) {
      const res = await fetch(base + p);
      expect(res.status).toBe(200);
      expect(await res.text()).toMatch(/^retry: \d{4}\n\n$/);
    }
    const res = await fetch(base + '/templates');
    expect(res.status).toBe(503);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
  it('/metrics exposes stream metrics', async () => {
    const text = await (await fetch(base + '/metrics')).text();
    expect(text).toContain('stream_active_connections');
  });
  it('drain sends a retry hint and closes clients', async () => {
    const ctrl = new AbortController();
    const res = await fetch(base + '/stream', { signal: ctrl.signal });
    await tick();
    await server.drain(40);
    const text = await res.text();
    expect(text).toMatch(/retry: \d{4}\n\n/);
    const ms = Number(text.match(/retry: (\d+)/)![1]);
    expect(ms).toBeGreaterThanOrEqual(1000);
    expect(ms).toBeLessThanOrEqual(5000);
  });
  it('sends heartbeats', async () => {
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    await start({ heartbeatMs: 20 });
    const ctrl = new AbortController();
    const res = await fetch(base + '/', { signal: ctrl.signal });
    const reader = res.body!.getReader(); let s = '';
    while (!s.includes(':\n\n')) s += new TextDecoder().decode((await reader.read()).value);
    ctrl.abort();
    expect(s).toContain(':\n\n');
  });
  it('gzips /stream with a flush per event only when enabled, but never the legacy root', async () => {
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    await start({ sseGzip: true });
    const legacy = await readSse('/', 1, { 'Accept-Encoding': 'gzip' });
    expect(legacy.headers.get('content-encoding')).toBeNull();
    expect(legacy.events[0]).toBe('data: {"type":"connection","status":"connected"}');
    const chunks: Buffer[] = [];
    const req = http.get(base + '/stream?view=all', { headers: { 'Accept-Encoding': 'gzip' } });
    const res = await new Promise<http.IncomingMessage>(r => req.on('response', r));
    expect(res.headers['content-encoding']).toBe('gzip');
    const gunzip = zlib.createGunzip(); res.pipe(gunzip);
    let text = '';
    gunzip.on('data', c => { chunks.push(c); text += c.toString(); });
    await tick();
    const body = tpl({ job_id: 'z' });
    const rx = Date.now();
    state.ingest(toRawMessage(Buffer.from(body), rx)!);
    for (let i = 0; i < 40 && !text.includes(body); i++) await tick(10);
    req.destroy();
    expect(text).toBe(`id: ${rx}\ndata: ${body}\n\n`);
  });
});
