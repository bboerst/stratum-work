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

// --- Change-tracking primers (#143 follow-up: gray leftmost bars after a view switch) ---------------------------
import { beforeEach } from 'vitest';
import { changeTrackerPrimers } from '../chartHistory';
import { createTemplateChangeTracker, TemplateChangeType } from '../../utils/templateChangeDetection';
import { clearProcessedDataCache } from '../../utils/templateDataProcessor';
import type { StratumV1Data } from '../types';

const e = (seq: number, timeMs: number, pool: string) => ({ seq, timeMs, data: { pool_name: pool } });

describe('changeTrackerPrimers', () => {
  it("returns each pool's entry immediately before its first plotted one", () => {
    const all = [e(1, 10, 'A'), e(2, 20, 'A'), e(3, 15, 'B'), e(4, 30, 'A'), e(5, 40, 'B')];
    const plotted = [all[3], all[4]]; // A from t=30, B from t=40
    expect(changeTrackerPrimers(all, plotted).map(x => x.seq)).toEqual([3, 2]); // B@15 then A@20, oldest first
  });

  it('returns nothing for a pool with no earlier entry, or not plotted at all', () => {
    const all = [e(1, 10, 'A'), e(2, 20, 'B')];
    expect(changeTrackerPrimers(all, [all[0]])).toEqual([]);
  });

  it('never returns a plotted entry', () => {
    const all = [e(1, 10, 'A'), e(2, 10, 'A')];
    expect(changeTrackerPrimers(all, [all[1]]).map(x => x.seq)).toEqual([1]);
    expect(changeTrackerPrimers(all, all)).toEqual([]);
  });
});

describe('priming the change tracker colors the first plotted bar', () => {
  const CB1 = '02000000010000000000000000000000000000000000000000000000000000000000000000ffffffff0e2f746573742f';
  const CB2 = 'ffffffff0100000000000000000a6a08deadbeefcafebabe00000000';
  const tpl = (overrides: Partial<StratumV1Data>): StratumV1Data => ({
    pool_name: 'TestPool', timestamp: '2024-01-01T00:00:00.000', job_id: 'j1', height: 100,
    prev_hash: 'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344', version: '20000000',
    coinbase1: CB1, coinbase2: CB2, extranonce1: 'aabbccdd', extranonce2_length: 4, clean_jobs: false,
    first_transaction: '', fee_rate: 0, merkle_branches: ['aaaa', 'bbbb'], nbits: '1d00ffff', ntime: '60000000',
    ...overrides,
  });
  beforeEach(() => clearProcessedDataCache());

  it('without a primer the first plotted template has no change types (gray); with one it does', () => {
    const earlier = tpl({});
    const firstPlotted = tpl({ job_id: 'j2', timestamp: '2024-01-01T00:00:30.000', merkle_branches: ['aaaa', 'cccc'] });

    const unprimed = createTemplateChangeTracker();
    expect(unprimed.process(firstPlotted).changeTypes).toHaveLength(0);

    clearProcessedDataCache();
    const primed = createTemplateChangeTracker();
    primed.process(earlier); // the primer
    expect(primed.process(firstPlotted).changeTypes).toContain(TemplateChangeType.MERKLE_BRANCHES);
  });
});
