import { describe, expect, it, vi } from 'vitest';
import { prefillHeights, prefillTemplateBuffer, selectPrefillTemplates, PREFILL_WINDOW_MS } from '../prefill';
import { TemplateBuffer } from '../templateBuffer';
import type { StratumV1Data } from '../types';

const NOW_MS = 1_794_514_000_000;
const usHex = (ms: number) => (BigInt(ms) * BigInt(1_000_000)).toString(16);
const rec = (pool: string, agoMs: number, extra: Record<string, unknown> = {}) =>
  ({ pool_name: pool, timestamp: usHex(NOW_MS - agoMs), height: 101, ...extra });

describe('prefillHeights', () => {
  it('reads tip + 1, and the tip too while it is younger than the chart window', () => {
    expect(prefillHeights({ height: 100, timestamp: (NOW_MS - 60_000) / 1000 }, NOW_MS)).toEqual([101, 100]);
    expect(prefillHeights({ height: 100, timestamp: (NOW_MS - PREFILL_WINDOW_MS - 1000) / 1000 }, NOW_MS)).toEqual([101]);
  });
});

describe('selectPrefillTemplates', () => {
  const none = () => false;

  it('keeps the window plus each pool\'s latest before it, oldest first', () => {
    const out = selectPrefillTemplates([
      rec('A', 600_000), rec('A', 400_000), rec('A', 10_000),
      rec('B', 500_000),
      rec('C', 20_000), rec('C', 5_000),
    ], { nowMs: NOW_MS, isBlacklisted: none });
    expect(out.map(r => `${r.pool_name}-${(NOW_MS - Number(BigInt('0x' + r.timestamp) / BigInt(1_000_000))) / 1000}s`))
      .toEqual(['B-500s', 'A-400s', 'C-20s', 'A-10s', 'C-5s']);
  });

  it('drops blacklisted pools, exactly as the stream route does', () => {
    const out = selectPrefillTemplates([rec('A', 1000), rec('Secret', 1000)], {
      nowMs: NOW_MS, isBlacklisted: pool => pool === 'Secret',
    });
    expect(out.map(r => r.pool_name)).toEqual(['A']);
  });

  it('drops other chains\' templates and rows without a pool or a parseable timestamp', () => {
    const out = selectPrefillTemplates([
      rec('A', 1000),
      rec('A', 900, { chain_family: 'bch' }),
      rec('', 800),
      { pool_name: 'B', timestamp: 'zz' },
    ], { nowMs: NOW_MS, isBlacklisted: none });
    expect(out).toHaveLength(1);
  });
});

describe('prefillTemplateBuffer', () => {
  const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

  it('does not fetch anything when historical data is disabled', async () => {
    const fetchFn = vi.fn();
    const buffer = new TemplateBuffer();
    const result = await prefillTemplateBuffer(buffer, { historicalDataEnabled: false, fetchFn });
    expect(result).toEqual({ status: 'disabled', count: 0 });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(buffer.size).toBe(0);
  });

  it('seeds the tip and templates, marked as pre-filled', async () => {
    const templates = [rec('A', 2000), rec('B', 1000)] as unknown as StratumV1Data[];
    const fetchFn = vi.fn(async () => okResponse({ enabled: true, tip: { height: 100 }, templates }));
    const buffer = new TemplateBuffer();
    const result = await prefillTemplateBuffer(buffer, { historicalDataEnabled: true, fetchFn });
    expect(fetchFn).toHaveBeenCalledWith('/api/realtime-prefill', { cache: 'no-store' });
    expect(result).toEqual({ status: 'loaded', count: 2 });
    expect(buffer.tipHeight).toBe(100);
    expect(buffer.entries().every(e => e.origin === 'prefill')).toBe(true);
  });

  it('respects a server that has history disabled', async () => {
    const fetchFn = vi.fn(async () => okResponse({ enabled: false, tip: null, templates: [] }));
    const result = await prefillTemplateBuffer(new TemplateBuffer(), { historicalDataEnabled: true, fetchFn });
    expect(result.status).toBe('disabled');
  });

  it('throws on a failed request', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500 }) as Response);
    await expect(prefillTemplateBuffer(new TemplateBuffer(), { historicalDataEnabled: true, fetchFn }))
      .rejects.toThrow('500');
  });
});
