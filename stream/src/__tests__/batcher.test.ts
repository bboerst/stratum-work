import { describe, expect, it, vi } from 'vitest';
import { Batcher } from '../db.js';

describe('Batcher', () => {
  it('flushes when maxItems reached', async () => {
    const flush = vi.fn(async () => {});
    const b = new Batcher<number>({ maxItems: 2, maxMs: 10_000, flush });
    await Promise.all([b.add(1), b.add(2)]);
    expect(flush).toHaveBeenCalledWith([1, 2]);
  });
  it('flushes after maxMs', async () => {
    vi.useFakeTimers();
    const flush = vi.fn(async () => {});
    const b = new Batcher<number>({ maxItems: 100, maxMs: 250, flush });
    const p = b.add(1);
    await vi.advanceTimersByTimeAsync(250);
    await p;
    expect(flush).toHaveBeenCalledWith([1]);
    vi.useRealTimers();
  });
  it('rejects all adds in a failed batch', async () => {
    const b = new Batcher<number>({ maxItems: 1, maxMs: 10, flush: async () => { throw new Error('db'); } });
    await expect(b.add(1)).rejects.toThrow('db');
  });
  it('flushes batches sequentially and keeps later batches working after a failure', async () => {
    const seen: number[][] = [];
    let fail = true;
    const b = new Batcher<number>({
      maxItems: 2, maxMs: 10_000,
      flush: async (items) => { seen.push(items); if (fail) { fail = false; throw new Error('db'); } },
    });
    const first = Promise.allSettled([b.add(1), b.add(2)]);
    const second = Promise.all([b.add(3), b.add(4)]);
    expect((await first).map(r => r.status)).toEqual(['rejected', 'rejected']);
    await second;
    expect(seen).toEqual([[1, 2], [3, 4]]);
  });
});
