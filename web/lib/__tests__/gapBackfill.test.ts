import { describe, expect, it, vi } from 'vitest';
import { BACKFILL_DELAYS_MS, BACKFILL_MIN_INTERVAL_MS, GapBackfill } from '../gapBackfill';

/** A fake clock and timers, and a buffer whose gaps the test sets. */
function harness() {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const state = { gapVersion: 0, pending: 0, canRun: true, readsAt: [] as number[], onRead: () => {} };
  const bf = new GapBackfill({
    read: async () => { state.readsAt.push(now); state.onRead(); },
    pending: () => state.pending,
    gapVersion: () => state.gapVersion,
    canRun: () => state.canRun,
    now: () => now,
    random: () => 0,
    setTimer: (fn, ms) => { const t = { at: now + ms, fn }; timers.push(t); return t; },
    clearTimer: t => { const i = timers.indexOf(t as never); if (i >= 0) timers.splice(i, 1); },
  });
  /** Advances the clock to `to`, firing due timers in order. */
  const advance = async (to: number) => {
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > to) break;
      timers.shift();
      now = next.at;
      next.fn();
      await vi.waitFor(() => Promise.resolve());
    }
    now = to;
  };
  const gap = () => { state.gapVersion++; state.pending++; bf.notify(); };
  return { bf, state, advance, gap, timers, at: (t: number) => { now = t; } };
}

describe('GapBackfill', () => {
  it('reads 8 s after the first gap, and new gaps do not push the read back', async () => {
    const h = harness();
    h.gap();
    for (let t = 2_000; t <= 30_000; t += 2_000) {
      await h.advance(t);
      h.gap(); // a pool's first live template every 2 s, as at page load
    }
    expect(h.state.readsAt[0]).toBe(BACKFILL_DELAYS_MS[0]);
  });

  it('stops when the gaps are filled', async () => {
    const h = harness();
    h.state.onRead = () => { h.state.pending = 0; };
    h.gap();
    await h.advance(120_000);
    expect(h.state.readsAt).toEqual([BACKFILL_DELAYS_MS[0]]);
  });

  it('tries at 8, 20 and 45 s while gaps remain, then waits for a new gap', async () => {
    const h = harness();
    h.gap();
    await h.advance(200_000);
    expect(h.state.readsAt).toEqual(BACKFILL_DELAYS_MS);
    h.gap(); // a new gap starts over
    await h.advance(300_000);
    expect(h.state.readsAt).toEqual([...BACKFILL_DELAYS_MS, 200_000 + BACKFILL_DELAYS_MS[0], 200_000 + BACKFILL_DELAYS_MS[1], 200_000 + BACKFILL_DELAYS_MS[2]]);
  });

  it('a pool that keeps bursting costs at most one read per minimum interval', async () => {
    const h = harness();
    h.state.onRead = () => { h.state.pending = 0; };
    for (let t = 0; t <= 120_000; t += 1_000) {
      await h.advance(t);
      h.gap();
    }
    const gaps = h.state.readsAt.slice(1).map((t, i) => t - h.state.readsAt[i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(BACKFILL_MIN_INTERVAL_MS);
    expect(h.state.readsAt.length).toBeGreaterThan(5); // it still keeps up
  });

  it('does not read while paused or hidden, and starts over on the next gap after resuming', async () => {
    const h = harness();
    h.state.canRun = false;
    h.gap();
    await h.advance(60_000);
    expect(h.state.readsAt).toEqual([]);
    h.state.canRun = true;
    h.state.onRead = () => { h.state.pending = 0; };
    h.gap(); // the next gap after resuming
    await h.advance(120_000);
    expect(h.state.readsAt).toEqual([60_000 + BACKFILL_DELAYS_MS[0]]);
  });

  it('does nothing after dispose', async () => {
    const h = harness();
    h.gap();
    h.bf.dispose();
    await h.advance(60_000);
    expect(h.state.readsAt).toEqual([]);
  });
});
