import { describe, expect, it } from 'vitest';
import { STALE_AFTER_WINDOWS, staleBefore, windowedHistory } from '../chartHistory';

const p = (timestamp: number) => ({ timestamp });

describe('windowedHistory (#143: bars scroll off the left edge)', () => {
  it('keeps the point before the cutoff plus everything in the window', () => {
    const history = [p(10), p(20), p(30), p(40)];
    expect(windowedHistory(history, 25)).toEqual([p(20), p(30), p(40)]);
  });

  it("keeps a quiet pool's last template when nothing is in the window (its bar spans the chart)", () => {
    const history = [p(10), p(20)];
    expect(windowedHistory(history, 100)).toEqual([p(20)]);
  });

  it('keeps everything when all points are in the window', () => {
    const history = [p(50), p(60)];
    expect(windowedHistory(history, 40)).toEqual([p(50), p(60)]);
  });

  it('keeps a point exactly at the cutoff and the one before it', () => {
    expect(windowedHistory([p(10), p(25), p(30)], 25)).toEqual([p(10), p(25), p(30)]);
  });

  it('drops a pool whose newest template is older than staleBeforeMs (e.g. a disconnected collector)', () => {
    expect(windowedHistory([p(10), p(20)], 100, 50)).toEqual([]);
    expect(windowedHistory([p(10), p(60)], 100, 50)).toEqual([p(60)]);
  });

  it('handles an empty history', () => {
    expect(windowedHistory([], 100)).toEqual([]);
  });

  it('does not mutate the input', () => {
    const history = [p(10), p(20)];
    windowedHistory(history, 100);
    expect(history).toEqual([p(10), p(20)]);
  });
});

describe('staleBefore', () => {
  it(`is ${STALE_AFTER_WINDOWS} windows before now`, () => {
    expect(staleBefore(1_000_000, 30_000)).toBe(1_000_000 - STALE_AFTER_WINDOWS * 30_000);
  });
});
