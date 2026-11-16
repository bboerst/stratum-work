/**
 * The browser's fee-rate client (lib/txFeeRates.ts, #198): batching into one /api/tx request per flush, the per-txid
 * cache, the labels the table shows, the mempool.space source and fallback, and the runtime setting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFeeRateClient, FEE_LABEL, formatFeeRate, templateTimeMs, txInfoToFeeRate } from '../txFeeRates';
import { txApiConfigFromEnv } from '../txApiConfig';
import { feeRates } from '../db/tx';
import type { TxInfo } from '../db/tx';

const tx = (n: number) => n.toString(16).padStart(64, '0');
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);

type Answer = (txid: string) => Partial<TxInfo>;

/** A fetch that answers /api/tx from `answer` and mempool.space from `mempool`, recording every URL. */
function fakeFetch(answer: Answer = t => ({ found: true, status: 'in_mempool', effective_fee_rate: parseInt(t, 16) }),
                   opts: { status?: number; supported?: boolean; mempool?: (url: string) => unknown } = {}) {
  const urls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith('https://mempool.space/')) {
      const body = opts.mempool?.(url);
      return new Response(JSON.stringify(body ?? {}), { status: body === undefined ? 404 : 200 });
    }
    const u = new URL(url, 'http://localhost');
    const txids = (u.searchParams.get('txids') ?? '').split(',');
    if (opts.status && opts.status !== 200) return new Response('{}', { status: opts.status });
    if (opts.supported === false) return Response.json({ supported: false, txs: [] });
    return Response.json({ supported: true, txs: txids.map(t => ({ txid: t, found: false, status: 'not_seen', ...answer(t) })) });
  });
  return { fetch: fn as unknown as typeof fetch, urls };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const settle = async () => {
  await vi.advanceTimersByTimeAsync(300);
};

describe('fee-rate client, local source', () => {
  it('sends one request for every txid asked for in the same flush, and caches them', async () => {
    const f = fakeFetch();
    const c = createFeeRateClient({ fetch: f.fetch });
    c.configure({ source: 'local' });
    const ps = [1, 2, 3, 2].map(n => c.get(tx(n)));
    await settle();
    expect(await Promise.all(ps)).toEqual([1, 2, 3, 2]);
    expect(f.urls).toEqual([`/api/tx?txids=${tx(1)},${tx(2)},${tx(3)}`]);
    // cached: no new request
    expect(await c.get(tx(3))).toBe(3);
    const many = c.getMany([tx(1), tx(4)]);
    await settle();
    expect([...(await many)]).toEqual([[tx(1), 1], [tx(4), 4]]);
    expect(f.urls.slice(1)).toEqual([`/api/tx?txids=${tx(4)}`]);
  });

  it('splits large flushes into requests of at most 100 txids', async () => {
    const f = fakeFetch();
    const c = createFeeRateClient({ fetch: f.fetch });
    c.configure({ source: 'local' });
    const all = c.getMany(Array.from({ length: 250 }, (_, i) => tx(i + 1)));
    await settle();
    expect((await all).size).toBe(250);
    expect(f.urls.map(u => new URL(u, 'http://x').searchParams.get('txids')!.split(',').length)).toEqual([100, 100, 50]);
  });

  it('waits for the runtime config before the first request', async () => {
    const f = fakeFetch();
    const c = createFeeRateClient({ fetch: f.fetch });
    const p = c.get(tx(7));
    await settle();
    expect(f.urls).toEqual([]);
    c.configure({ source: 'local' });
    await settle();
    expect(await p).toBe(7);
  });

  it('labels unseen and off-mempool transactions, and asks again about unseen ones later', async () => {
    const f = fakeFetch(t => t === tx(1) ? { found: false, status: 'not_seen' }
      : t === tx(2) ? { found: true, status: 'off_mempool', effective_fee_rate: null }
        : { found: true, status: 'unknown', effective_fee_rate: null });
    const c = createFeeRateClient({ fetch: f.fetch });
    c.configure({ source: 'local' });
    const got = c.getMany([tx(1), tx(2), tx(3)]);
    await settle();
    expect([...(await got).values()]).toEqual([FEE_LABEL.notSeen, FEE_LABEL.offMempool, FEE_LABEL.na]);
    vi.setSystemTime(NOW + 31_000);
    const again = c.getMany([tx(1), tx(2)]);
    await settle();
    await again;
    expect(f.urls[1]).toBe(`/api/tx?txids=${tx(1)}`);   // only the unseen one
  });

  it('passes historical times as `at`, one request per hour', async () => {
    const f = fakeFetch();
    const c = createFeeRateClient({ fetch: f.fetch });
    c.configure({ source: 'local' });
    const day = NOW - 86_400_000;
    const got = c.getMany([tx(1), tx(2), tx(3), tx(4)],
      t => ({ [tx(1)]: day + 60_000, [tx(2)]: day + 120_000, [tx(3)]: day + 3 * 3_600_000, [tx(4)]: NOW - 1000 })[t]);
    await settle();
    expect((await got).size).toBe(4);
    expect(f.urls.sort()).toEqual([
      `/api/tx?txids=${tx(1)},${tx(2)}&at=${day + 3_600_000}`,
      `/api/tx?txids=${tx(3)}&at=${day + 3 * 3_600_000}`,
      `/api/tx?txids=${tx(4)}`,
    ].sort());
  });

  it('shows Error / N/A when the API fails or is unsupported, without caching errors', async () => {
    const failing = fakeFetch(undefined, { status: 500 });
    const c = createFeeRateClient({ fetch: failing.fetch });
    c.configure({ source: 'local' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = c.get(tx(1));
    await settle();
    expect(await p).toBe(FEE_LABEL.error);
    const q = c.get(tx(1));
    await settle();
    await q;
    expect(failing.urls).toHaveLength(2);

    const unsupported = fakeFetch(undefined, { supported: false });
    const u = createFeeRateClient({ fetch: unsupported.fetch });
    u.configure({ source: 'local' });
    const r = u.get(tx(1));
    await settle();
    expect(await r).toBe(FEE_LABEL.na);
  });

  it('falls back to mempool.space on failure only when configured', async () => {
    const f = fakeFetch(undefined, { status: 503, mempool: url => url.includes('/v1/cpfp/') ? { effectiveFeePerVsize: 12.345 } : undefined });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = createFeeRateClient({ fetch: f.fetch });
    c.configure({ source: 'local', mempoolSpaceFallback: true });
    const p = c.get(tx(1));
    await settle();
    expect(await p).toBe(12.3);
    expect(f.urls).toEqual([`/api/tx?txids=${tx(1)}`, `https://mempool.space/api/v1/cpfp/${tx(1)}`]);
  });
});

describe('fee-rate client, mempool.space source (the previous behavior)', () => {
  it('is the default, and looks each txid up as before', async () => {
    const f = fakeFetch(undefined, { mempool: url => url.includes('/api/tx/') ? { fee: 2820, weight: 564 } : undefined });
    const c = createFeeRateClient({ fetch: f.fetch });
    c.configure(undefined);
    const ps = [c.get(tx(1)), c.get(tx(1))];
    await settle();
    expect(await Promise.all(ps)).toEqual([20, 20]);
    expect(f.urls).toEqual([`https://mempool.space/api/v1/cpfp/${tx(1)}`, `https://mempool.space/api/tx/${tx(1)}`]);
  });

  it('answers "not found" when mempool.space has nothing, and uses it without a config after a while', async () => {
    const f = fakeFetch();
    const c = createFeeRateClient({ fetch: f.fetch, configWaitMs: 1000 });
    const p = c.get(tx(1));
    await vi.advanceTimersByTimeAsync(1500);   // flush at 250 ms, then the 1 s config wait
    expect(await p).toBe(FEE_LABEL.notFound);
  });
});

describe('fee-rate values', () => {
  it('formats like before', () => {
    expect([formatFeeRate(123.6), formatFeeRate(12.34), formatFeeRate(1.234)]).toEqual([124, 12.3, 1.23]);
    expect(txInfoToFeeRate({ found: true, status: 'mined', effective_fee_rate: 5.555 })).toBe(5.56);
  });

  it('computes the package rate from ancestors only', () => {
    expect(feeRates(2820, 141, 1, 2820, 141)).toEqual({ fee_rate: 20, ancestor_fee_rate: 20, effective_fee_rate: 20 });
    // low-fee parent pulls a child down
    expect(feeRates(5000, 100, 2, 5200, 300).effective_fee_rate).toBeCloseTo(17.333, 3);
    // high-fee parent: the child is mined at its own rate after it
    expect(feeRates(1000, 100, 2, 11000, 200)).toEqual({ fee_rate: 10, ancestor_fee_rate: 55, effective_fee_rate: 10 });
    expect(feeRates(null, 100, null, null, null)).toEqual({ fee_rate: null, ancestor_fee_rate: null, effective_fee_rate: null });
  });

  it('reads template times', () => {
    const ms = Date.UTC(2026, 0, 1);
    expect(templateTimeMs((BigInt(ms) * BigInt(1_000_000)).toString(16))).toBe(ms);
    expect(templateTimeMs('0x' + (BigInt(ms) * BigInt(1_000_000)).toString(16))).toBe(ms);
    expect(templateTimeMs('2026-01-01T00:00:00')).toBe(ms);
    expect(templateTimeMs('')).toBeUndefined();
  });
});

describe('TX_API_SOURCE', () => {
  it('auto: local only in Postgres mode with history enabled', () => {
    expect(txApiConfigFromEnv({})).toEqual({ source: 'mempool.space', mempoolSpaceFallback: false });
    expect(txApiConfigFromEnv({ DB_BACKEND: 'postgres' })).toEqual({ source: 'local', mempoolSpaceFallback: false });
    expect(txApiConfigFromEnv({ DB_BACKEND: 'postgres', ENABLE_HISTORICAL_DATA: 'false' }).source).toBe('mempool.space');
  });

  it('explicit values and the fallback', () => {
    expect(txApiConfigFromEnv({ TX_API_SOURCE: 'mempool.space', DB_BACKEND: 'postgres' }).source).toBe('mempool.space');
    expect(txApiConfigFromEnv({ TX_API_SOURCE: 'local' }).source).toBe('local');
    expect(txApiConfigFromEnv({ DB_BACKEND: 'postgres', TX_API_MEMPOOL_SPACE_FALLBACK: 'true' }).mempoolSpaceFallback).toBe(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(txApiConfigFromEnv({ TX_API_SOURCE: 'bogus' }).source).toBe('mempool.space');
  });
});
