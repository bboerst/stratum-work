import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyStreamMessage, startLive, streamUrl } from '../sources';
import { TemplateStore } from '../store';
import { makeRaw, tsHex } from './fixtures';

const NOW = 1_700_000_600_000;
class FakeES { static last: FakeES; url: string; onmessage?: (e: { data: string }) => void; onopen?: () => void; onerror?: () => void;
  constructor(url: string) { this.url = url; FakeES.last = this; } close() {} }

/** A 200 response with a non-JSON content type whose body never finishes (like an SSE stream). */
class NonJson { constructor(public contentType: string) {} }

function deps(routes: Record<string, unknown>) {
  const fetch = vi.fn(async (url: string) => {
    const key = Object.keys(routes).find(k => url.includes(k));
    const json = { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) };
    if (!key || routes[key] instanceof Error) return { ok: false, status: 500, headers: json, json: async () => ({}) };
    const v = routes[key];
    if (v instanceof NonJson) return { ok: true, status: 200, headers: { get: () => v.contentType }, json: () => new Promise(() => {}) };
    return { ok: true, status: 200, headers: json, json: async () => v };
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeES as never, now: () => NOW };
}

describe('classifyStreamMessage', () => {
  it('recognises each kind', () => {
    expect(classifyStreamMessage(makeRaw()).kind).toBe('template');
    expect(classifyStreamMessage({ type: 'block', data: { hash: 'h' } }).kind).toBe('block');
    expect(classifyStreamMessage({ type: 'routing', site: 's', targets: [] }).kind).toBe('routing');
    expect(classifyStreamMessage({ type: 'resync', since: 1, cursor: 2 })).toEqual({ kind: 'resync', since: 1, cursor: 2 });
    expect(classifyStreamMessage({ type: 'arrival' }).kind).toBe('ignore');
    expect(classifyStreamMessage(null).kind).toBe('ignore');
  });
});

describe('streamUrl', () => {
  it('appends /stream with the cursor', () => {
    expect(streamUrl('https://stream.stratum.work/', 5)).toBe('https://stream.stratum.work/stream?view=all&after=5');
  });
});

describe('startLive', () => {
  beforeEach(() => { FakeES.last = undefined as never; }); // tests share endpoint URLs; never match a previous test's stream
  it('backfills then follows the stream from the returned cursor', async () => {
    const store = new TemplateStore({ retentionMs: 3_600_000, now: () => NOW, schedule: () => 0 });
    const d = deps({ '/api/pools': [], '/api/blocks': { blocks: [] }, '/templates?since=': { items: [makeRaw({ timestamp: tsHex(NOW - 1000) })], cursor: 42 } });
    const stop = startLive(store, { streamEndpoint: 'https://s.example', templatesEndpoint: 'https://s.example' }, d);
    await vi.waitFor(() => expect(FakeES.last?.url).toBe('https://s.example/stream?view=all&after=42'));
    expect(store.templates()).toHaveLength(1);
    expect((d.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(c => String(c[0]).includes(`since=${NOW - 3_600_000}&view=all`))).toBe(true);
    stop();
  });
  it('marks history unavailable when backfill fails and still connects', async () => {
    const store = new TemplateStore({ retentionMs: 3_600_000, now: () => NOW, schedule: () => 0 });
    const d = deps({ '/api/pools': new Error(), '/api/blocks': new Error(), '/templates': new Error() });
    const stop = startLive(store, { streamEndpoint: 'https://s.example', templatesEndpoint: 'https://s.example' }, d);
    await vi.waitFor(() => expect(FakeES.last?.url).toContain(`after=${NOW}`));
    const st = store.getSnapshot().status;
    expect([st.historyUnavailable, st.poolsUnavailable, st.blocksUnavailable]).toEqual([true, true, true]);
    stop();
  });
  it('marks history unavailable when a resync refetch fails', async () => {
    const store = new TemplateStore({ retentionMs: 3_600_000, now: () => NOW, schedule: () => 0 });
    const d = deps({ '/api/pools': [], '/api/blocks': { blocks: [] }, [`since=${NOW - 3_600_000}`]: { items: [], cursor: 7 }, 'since=123': new Error() });
    const stop = startLive(store, { streamEndpoint: 'https://s.example', templatesEndpoint: 'https://s.example' }, d);
    await vi.waitFor(() => expect(FakeES.last?.url).toContain('after=7'));
    expect(store.getSnapshot().status.historyUnavailable).toBe(false);
    FakeES.last.onmessage!({ data: JSON.stringify({ type: 'resync', since: 123, cursor: 456 }) });
    await vi.waitFor(() => expect(store.getSnapshot().status.historyUnavailable).toBe(true));
    stop();
  });
  it('marks history unavailable on resync when there is no templates endpoint', async () => {
    const store = new TemplateStore({ retentionMs: 3_600_000, now: () => NOW, schedule: () => 0 });
    const d = deps({ '/api/pools': [], '/api/blocks': { blocks: [] } });
    const stop = startLive(store, { streamEndpoint: 'https://s.example', templatesEndpoint: '' }, d);
    await vi.waitFor(() => expect(FakeES.last?.url).toBe(`https://s.example/stream?view=all&after=${NOW}`));
    store.setStatus({ historyUnavailable: false });
    FakeES.last.onmessage!({ data: JSON.stringify({ type: 'resync', since: 1, cursor: 2 }) });
    expect(store.getSnapshot().status.historyUnavailable).toBe(true);
    stop();
  });
  it('does not ingest a resync backfill that resolves after stop', async () => {
    const store = new TemplateStore({ retentionMs: 3_600_000, now: () => NOW, schedule: () => 0 });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const base = deps({ '/api/pools': [], '/api/blocks': { blocks: [] }, [`since=${NOW - 3_600_000}`]: { items: [], cursor: 7 } });
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('since=123')) { await gate; return { ok: true, status: 200, json: async () => ({ items: [makeRaw({ timestamp: tsHex(NOW - 500) })], cursor: 9 }) }; }
      return (base.fetch as unknown as (u: string) => Promise<unknown>)(url);
    });
    const d = { ...base, fetch: fetch as unknown as typeof globalThis.fetch };
    const stop = startLive(store, { streamEndpoint: 'https://s.example', templatesEndpoint: 'https://s.example' }, d);
    await vi.waitFor(() => expect(FakeES.last?.url).toContain('after=7'));
    FakeES.last.onmessage!({ data: JSON.stringify({ type: 'resync', since: 123, cursor: 456 }) });
    stop();
    release();
    await new Promise(r => setTimeout(r, 20));
    expect(store.templates()).toHaveLength(0);
  });
  it('without a stream endpoint, marks history unavailable and stays disconnected', async () => {
    const store = new TemplateStore({ retentionMs: 3_600_000, now: () => NOW, schedule: () => 0 });
    const d = deps({ '/api/pools': [], '/api/blocks': { blocks: [] } });
    const stop = startLive(store, { streamEndpoint: '', templatesEndpoint: 'https://s.example' }, d);
    await vi.waitFor(() => expect(store.getSnapshot().status.historyUnavailable).toBe(true));
    await new Promise(r => setTimeout(r, 10));
    expect(FakeES.last).toBeUndefined();
    expect(store.getSnapshot().status.connected).toBe(false);
    expect((d.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(c => String(c[0]).includes('/templates'))).toBe(false);
    stop();
  });
  it('flushes buffered templates on stop', async () => {
    const store = new TemplateStore({ retentionMs: 3_600_000, now: () => NOW, schedule: () => 0 });
    const d = deps({ '/api/pools': [], '/api/blocks': { blocks: [] } });
    const stop = startLive(store, { streamEndpoint: 'https://s.example', templatesEndpoint: '' }, d);
    await vi.waitFor(() => expect(FakeES.last?.url).toBe(`https://s.example/stream?view=all&after=${NOW}`));
    FakeES.last.onmessage!({ data: JSON.stringify(makeRaw({ timestamp: tsHex(NOW - 1000) })) });
    FakeES.last.onmessage!({ data: JSON.stringify(makeRaw({ timestamp: tsHex(NOW - 900), job_id: 'j2' })) });
    expect(store.templates()).toHaveLength(0); // still buffered (250 ms batch)
    stop();
    expect(store.templates()).toHaveLength(2);
  });
  it('tags blocks from the stream as stream-delivered', async () => {
    const store = new TemplateStore({ retentionMs: 3_600_000, now: () => NOW, schedule: () => 0 });
    const d = deps({ '/api/pools': [], '/api/blocks': { blocks: [{ hash: 'old', height: 1 }] } });
    const stop = startLive(store, { streamEndpoint: 'https://s.example', templatesEndpoint: '' }, d);
    await vi.waitFor(() => expect(FakeES.last?.url).toBe(`https://s.example/stream?view=all&after=${NOW}`));
    await vi.waitFor(() => expect(store.getSnapshot().blocks.has('old')).toBe(true));
    FakeES.last.onmessage!({ data: JSON.stringify({ type: 'block', id: 'new', timestamp: 't', data: { hash: 'new', height: 2 } }) });
    expect(store.getSnapshot().streamBlocks.map(b => [b.block.hash, b.rxMs])).toEqual([['new', NOW]]);
    stop();
  });
  it('treats a non-JSON /templates response as unavailable history and goes live at now', async () => {
    const store = new TemplateStore({ retentionMs: 3_600_000, now: () => NOW, schedule: () => 0 });
    const d = deps({ '/api/pools': [], '/api/blocks': { blocks: [] }, '/templates?since=': new NonJson('text/event-stream') });
    const stop = startLive(store, { streamEndpoint: 'https://s.example', templatesEndpoint: 'https://s.example' }, d);
    await vi.waitFor(() => expect(FakeES.last?.url).toBe(`https://s.example/stream?view=all&after=${NOW}`));
    expect(store.getSnapshot().status.historyUnavailable).toBe(true);
    stop();
  });
  it('aborts a backfill that does not answer within 15 s', async () => {
    vi.useFakeTimers();
    try {
      const store = new TemplateStore({ retentionMs: 3_600_000, now: () => NOW, schedule: () => 0 });
      const base = deps({ '/api/pools': [], '/api/blocks': { blocks: [] } });
      const fetch = vi.fn((url: string, init?: RequestInit) => {
        if (!url.includes('/templates')) return (base.fetch as unknown as (u: string) => Promise<unknown>)(url);
        return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      });
      FakeES.last = undefined as never;
      const stop = startLive(store, { streamEndpoint: 'https://s.example', templatesEndpoint: 'https://s.example' }, { ...base, fetch: fetch as unknown as typeof globalThis.fetch });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(FakeES.last).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2);
      expect(FakeES.last?.url).toBe(`https://s.example/stream?view=all&after=${NOW}`);
      expect(store.getSnapshot().status.historyUnavailable).toBe(true);
      stop();
    } finally { vi.useRealTimers(); }
  });
});
