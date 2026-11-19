/**
 * getMiningNotifyByHeight's cache (lib/db/mining-notify.ts): a height is cached for good only once it's final; the
 * height being mined, a future height, or one whose window is still open is cached for UNFINISHED_TTL_MS only. Before,
 * the first read was cached forever, so a page opened before a height was mined stayed empty until a restart.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LRUCache } from 'lru-cache';

// lru-cache keeps its own clock (performance.now, captured once when the dependency loads), so the expiry itself is
// lru-cache's tested behaviour; these tests check what the module asks of it: no TTL for a final height, the short
// TTL otherwise, and a read served from the cache within it.
async function load(final: boolean) {
  vi.resetModules();
  const fetchHeight = vi.fn(async (h: number) => [{ id: `${h}-${fetchHeight.mock.calls.length}`, height: h }]);
  vi.doMock('../db/postgres', () => ({
    isHeightFinal: vi.fn(async () => final),
    templatesAtHeight: fetchHeight,
  }));
  const mod = await import('../db/mining-notify');
  return { mod, fetchHeight };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../db/postgres');
});

describe('getMiningNotifyByHeight cache', () => {
  it('caches a final height for good (no TTL)', async () => {
    const { mod, fetchHeight } = await load(true);
    const set = vi.spyOn(LRUCache.prototype, 'set');
    const a = await mod.getMiningNotifyByHeight(900);
    const b = await mod.getMiningNotifyByHeight(900);
    expect(b).toBe(a);
    expect(fetchHeight).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][2]).toBeUndefined();
  });

  it('caches an unfinished height (being mined, future, window open) only for UNFINISHED_TTL_MS', async () => {
    const { mod, fetchHeight } = await load(false);
    const set = vi.spyOn(LRUCache.prototype, 'set');
    await mod.getMiningNotifyByHeight(1001);
    await mod.getMiningNotifyByHeight(1001);                    // within the TTL: served from the cache
    expect(fetchHeight).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][2]).toEqual({ ttl: mod.UNFINISHED_TTL_MS });
  });
});
