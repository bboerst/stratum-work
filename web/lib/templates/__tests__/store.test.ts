import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TemplateStore } from '../store';
import { clearProcessedDataCache } from '@/utils/templateDataProcessor';
import { makeRaw, tsHex } from './fixtures';
import { TemplateChangeType } from '@/utils/templateChangeDetection';

const NOW = 1_700_000_600_000;
function mk(retentionMs: number | null = 60 * 60_000) {
  const timers: Array<() => void> = [];
  const store = new TemplateStore({ retentionMs, now: () => NOW, schedule: fn => { timers.push(fn); return 0; } });
  return { store, fire: () => timers.splice(0).forEach(f => f()) };
}

beforeEach(() => clearProcessedDataCache());

describe('TemplateStore', () => {
  it('dedupes by mid and orders per connection', () => {
    const { store } = mk();
    const a = makeRaw({ timestamp: tsHex(NOW - 2000), job_id: 'a' });
    const b = makeRaw({ timestamp: tsHex(NOW - 1000), job_id: 'b' });
    expect(store.ingest([b, a, a])).toBe(2);
    expect(store.ingest([a])).toBe(0);
    expect(store.getSnapshot().byConnection.get('PoolA')!.map(t => t.raw.job_id)).toEqual(['a', 'b']);
  });
  it('maps legacy messages to default connection fields', () => {
    const { store } = mk();
    store.ingest([makeRaw({ timestamp: tsHex(NOW) })]);
    const t = store.templates()[0];
    expect([t.connectionId, t.site, t.mode]).toEqual(['PoolA', 'us-ash-legacy', 'observe']);
  });
  it('runs change detection in order even with out-of-order input', () => {
    const { store } = mk();
    const r1 = makeRaw({ timestamp: tsHex(NOW - 3000), merkle_branches: ['x'] });
    const r2 = makeRaw({ timestamp: tsHex(NOW - 2000), merkle_branches: ['y'] });
    const r3 = makeRaw({ timestamp: tsHex(NOW - 1000), merkle_branches: ['y'], version: '20002000' });
    store.ingest([r1, r3]);
    store.ingest([r2]);
    const ts = store.getSnapshot().byConnection.get('PoolA')!;
    expect(ts[1].change!.changeTypes).toContain(TemplateChangeType.MERKLE_BRANCHES);
    expect(ts[2].change!.changeTypes).toEqual([TemplateChangeType.VERSION]);
  });
  it('keeps change tracking separate per connection of the same pool', () => {
    const { store } = mk();
    store.ingest([
      makeRaw({ timestamp: tsHex(NOW - 2000), connection_id: 'c1', merkle_branches: ['x'] }),
      makeRaw({ timestamp: tsHex(NOW - 1000), connection_id: 'c2', merkle_branches: ['y'] }),
    ]);
    const s = store.getSnapshot();
    expect(s.byConnection.get('c2')![0].change!.changeTypes).toEqual([]); // first on c2 = baseline
  });
  it('evicts outside the live retention window, keeps everything when frozen', () => {
    const live = mk(60_000).store;
    live.ingest([makeRaw({ timestamp: tsHex(NOW - 120_000) }), makeRaw({ timestamp: tsHex(NOW - 10_000) })]);
    expect(live.templates()).toHaveLength(1);
    const frozen = mk(null).store;
    frozen.ingest([makeRaw({ timestamp: tsHex(NOW - 10 * 3_600_000) })]);
    expect(frozen.templates()).toHaveLength(1);
  });
  it('throttles notifications and bumps version', () => {
    const { store, fire } = mk();
    const fn = vi.fn();
    store.subscribe(fn);
    const v0 = store.getSnapshot().version;
    store.ingest([makeRaw({ timestamp: tsHex(NOW - 5) })]);
    store.ingest([makeRaw({ timestamp: tsHex(NOW - 4) })]);
    expect(fn).not.toHaveBeenCalled();
    fire();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().version).toBeGreaterThan(v0);
    expect(store.getSnapshot()).toBe(store.getSnapshot()); // stable between changes (useSyncExternalStore)
  });
  it('flush() cancels the pending timer so notifications stay spaced by notifyMs', () => {
    vi.useFakeTimers();
    try {
      const store = new TemplateStore({ retentionMs: null, notifyMs: 250 });
      const fn = vi.fn();
      store.subscribe(fn);
      store.ingest([makeRaw({ timestamp: tsHex(NOW - 5) })]); // schedules at t=250
      vi.advanceTimersByTime(100);
      store.flush();
      expect(fn).toHaveBeenCalledTimes(1);
      store.ingest([makeRaw({ timestamp: tsHex(NOW - 4) })]); // schedules at t=350
      vi.advanceTimersByTime(249); // t=349: stale t=250 timer must not flush early
      expect(fn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1); // t=350
      expect(fn).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('stale scheduled callbacks are no-ops after flush()', () => {
    const { store, fire } = mk();
    const fn = vi.fn();
    store.subscribe(fn);
    store.ingest([makeRaw({ timestamp: tsHex(NOW - 5) })]);
    store.flush();
    store.ingest([makeRaw({ timestamp: tsHex(NOW - 4) })]);
    fire(); // fires the stale callback and the current one
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('unsubscribe stops notifications', () => {
    const { store, fire } = mk();
    const fn = vi.fn();
    const off = store.subscribe(fn);
    store.ingest([makeRaw({ timestamp: tsHex(NOW - 5) })]);
    fire();
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    store.ingest([makeRaw({ timestamp: tsHex(NOW - 4) })]);
    fire();
    store.flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('skips templates already older than the retention cutoff without counting or notifying', () => {
    const { store, fire } = mk(60_000);
    const fn = vi.fn();
    store.subscribe(fn);
    const v0 = store.getSnapshot().version;
    expect(store.ingest([makeRaw({ timestamp: tsHex(NOW - 120_000) })])).toBe(0);
    fire();
    expect(fn).not.toHaveBeenCalled();
    expect(store.getSnapshot().version).toBe(v0);
    expect(store.ingest([makeRaw({ timestamp: tsHex(NOW - 120_000), job_id: 'old' }), makeRaw({ timestamp: tsHex(NOW - 10_000) })])).toBe(1);
    expect(store.templates()).toHaveLength(1);
  });
  it('re-identifies on setPools and stores blocks and routing', () => {
    const { store } = mk();
    store.ingest([makeRaw({ timestamp: tsHex(NOW) })]);
    store.setPools([{ id: '1', name: 'Tagged', tags: ['/test/'], regexes: [], addresses: [] }]);
    expect(store.templates()[0].identity.name).toBe('Tagged');
    store.ingestBlocks([{ hash: 'h', height: 1 } as never]);
    store.ingestRouting({ type: 'routing', site: 's', timestamp: 't', total_ths: 1, targets: [], remainder: { id: 'r', delivered_ths: 1, fallback_active: false }, workers: [] });
    expect(store.getSnapshot().blocks.get('h')!.height).toBe(1);
    expect(store.getSnapshot().routing.get('s')!.total_ths).toBe(1);
  });
  it('records stream-delivered blocks separately', () => {
    const { store } = mk();
    store.ingestBlocks([{ hash: 'a', height: 1 } as never]);
    store.ingestBlocks([{ hash: 'b', height: 2 } as never], 'stream');
    expect(store.getSnapshot().streamBlocks.map(b => [b.block.hash, b.rxMs])).toEqual([['b', NOW]]);
  });
  it('records a stream block already known from the API once, and keeps the last 50', () => {
    const { store } = mk();
    store.ingestBlocks([{ hash: 'a', height: 1 } as never]);
    store.ingestBlocks([{ hash: 'a', height: 1 } as never], 'stream');
    store.ingestBlocks([{ hash: 'a', height: 1 } as never], 'stream');
    expect(store.getSnapshot().streamBlocks.map(b => b.block.hash)).toEqual(['a']);
    store.ingestBlocks(Array.from({ length: 60 }, (_, i) => ({ hash: `s${i}`, height: 10 + i }) as never), 'stream');
    const sb = store.getSnapshot().streamBlocks;
    expect(sb).toHaveLength(50);
    expect(sb[sb.length - 1].block.hash).toBe('s59');
  });
});
