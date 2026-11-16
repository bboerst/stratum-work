import { describe, expect, it } from 'vitest';
import { fetchWithRetry, retryAfterMs, retryDelayMs } from '../fetchRetry';

const res = (status: number, headers: Record<string, string> = {}) =>
  new Response(status === 200 ? '{"ok":true}' : 'Too Many Requests', { status, headers });

function scripted(outcomes: Array<number | Error>, headers: Record<string, string> = {}) {
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const next = outcomes.shift();
    if (next === undefined) throw new Error('unexpected call');
    if (next instanceof Error) throw next;
    return res(next, headers);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const sleeps: number[] = [];
const sleep = async (ms: number) => { sleeps.push(ms); };
const opts = (fetchFn: typeof fetch) => ({ fetchFn, sleep, random: () => 1 });

describe('fetchWithRetry', () => {
  it('returns a successful response at once', async () => {
    const { fetchFn, calls } = scripted([200]);
    const r = await fetchWithRetry('/api/blocks?n=20', {}, opts(fetchFn));
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('retries a rate-limited (429) request, honouring Retry-After, until it succeeds', async () => {
    sleeps.length = 0;
    const { fetchFn, calls } = scripted([429, 429, 200], { 'retry-after': '2' });
    const r = await fetchWithRetry('/api/blocks?n=20', {}, opts(fetchFn));
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([2000, 2000]);   // Retry-After (2 s) beats the 500/1000 ms backoff
  });

  it('retries gateway errors and network failures with exponential backoff', async () => {
    sleeps.length = 0;
    const { fetchFn, calls } = scripted([502, new TypeError('Failed to fetch'), 504, 200]);
    const r = await fetchWithRetry('/x', {}, opts(fetchFn));
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  it('does not retry other errors (404, 500): the caller reports them', async () => {
    for (const status of [404, 500]) {
      const { fetchFn, calls } = scripted([status]);
      expect((await fetchWithRetry('/x', {}, opts(fetchFn))).status).toBe(status);
      expect(calls).toHaveLength(1);
    }
  });

  it('gives up after the retry budget: last response returned, last network error thrown', async () => {
    const a = scripted([429, 429, 429]);
    expect((await fetchWithRetry('/x', {}, { ...opts(a.fetchFn), retries: 2 })).status).toBe(429);
    expect(a.calls).toHaveLength(3);

    const b = scripted([new TypeError('Failed to fetch'), new TypeError('Failed to fetch')]);
    await expect(fetchWithRetry('/x', {}, { ...opts(b.fetchFn), retries: 1 })).rejects.toThrow('Failed to fetch');
    expect(b.calls).toHaveLength(2);
  });

  it('never retries an aborted request', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { fetchFn, calls } = scripted([abort, 200]);
    await expect(fetchWithRetry('/x', {}, opts(fetchFn))).rejects.toThrow('aborted');
    expect(calls).toHaveLength(1);
  });
});

describe('retry delays', () => {
  it('parses Retry-After as seconds or an HTTP date', () => {
    expect(retryAfterMs('3')).toBe(3000);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('soon')).toBeNull();
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(retryAfterMs('Thu, 01 Jan 2026 00:00:05 GMT', now)).toBe(5000);
  });

  it('caps every delay, Retry-After included', () => {
    const o = { baseDelayMs: 500, maxDelayMs: 8000, random: () => 0 };
    expect(retryDelayMs(0, null, o)).toBe(250);       // jitter floor: half the backoff
    expect(retryDelayMs(10, null, o)).toBe(8000);
    expect(retryDelayMs(0, 60_000, o)).toBe(8000);
  });
});
