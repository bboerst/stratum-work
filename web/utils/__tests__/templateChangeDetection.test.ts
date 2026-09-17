import { beforeEach, describe, expect, test } from 'vitest';

import {
  createTemplateChangeTracker,
  getChangeTypeDisplay,
  TemplateChangeType,
} from '../templateChangeDetection';
import { clearProcessedDataCache } from '../templateDataProcessor';
import { StratumV1Data } from '@/lib/types';

// --- Test fixtures -----------------------------------------------------------

// A minimal, bitcoinjs-parseable coinbase transaction split across the two
// stratum coinbase halves. coinbase1 carries the scriptSig (length byte +
// raw "/Test/" tail); formatCoinbaseRaw inserts extranonce1 + extranonce2
// between the length byte and the tail. coinbase2 starts at the sequence.
// Timestamps are ISO strings so chronological ordering is unambiguous.
const CB1 = '02000000010000000000000000000000000000000000000000000000000000000000000000ffffffff0e2f746573742f';
const CB2 = 'ffffffff0100000000000000000a6a08deadbeefcafebabe00000000';
const EN1 = 'aabbccdd';
const EN2_LEN = 4;
const T0 = '2024-01-01T00:00:00.000';

function makeData(overrides: Partial<StratumV1Data> = {}): StratumV1Data {
  return {
    pool_name: 'TestPool',
    timestamp: T0,
    job_id: 'job1',
    height: 100,
    prev_hash: 'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344',
    version: '20000000',
    coinbase1: CB1,
    coinbase2: CB2,
    extranonce1: EN1,
    extranonce2_length: EN2_LEN,
    clean_jobs: false,
    first_transaction: '',
    fee_rate: 0,
    merkle_branches: ['aaaa', 'bbbb'],
    nbits: '1d00ffff',
    ntime: '60000000',
    ...overrides,
  };
}

describe('template change detection', () => {
  beforeEach(() => {
    clearProcessedDataCache();
  });

  test('first template for a pool: hasChanges=true, no changeTypes', () => {
    const tracker = createTemplateChangeTracker();
    const result = tracker.process(makeData());
    expect(result.hasChanges).toBe(true);
    expect(result.changeTypes).toHaveLength(0);
  });

  test('detects core field changes between consecutive templates', () => {
    const tracker = createTemplateChangeTracker();
    tracker.process(makeData());

    const result = tracker.process(makeData({
      job_id: 'job2',
      timestamp: '2024-01-01T00:00:01.000',
      height: 101,
      prev_hash: '1111111111111111111111111111111111111111111111111111111111111111',
      version: '20400000',
      nbits: '1d010000',
      merkle_branches: ['aaaa', 'cccc'],
      clean_jobs: true,
    }));

    expect(result.changeTypes).toContain(TemplateChangeType.HEIGHT);
    expect(result.changeTypes).toContain(TemplateChangeType.PREV_HASH);
    expect(result.changeTypes).toContain(TemplateChangeType.VERSION);
    expect(result.changeTypes).toContain(TemplateChangeType.NBITS);
    expect(result.changeTypes).toContain(TemplateChangeType.MERKLE_BRANCHES);
    expect(result.changeTypes).toContain(TemplateChangeType.CLEAN_JOBS);
    expect(result.changeDetails.height).toEqual({ old: 100, new: 101 });
  });

  test('clean_jobs tracked only on the false -> true transition', () => {
    const tracker = createTemplateChangeTracker();
    tracker.process(makeData({ clean_jobs: false }));
    const toTrue = tracker.process(makeData({ job_id: 'j2', timestamp: '2024-01-01T00:00:01.000', clean_jobs: true }));
    expect(toTrue.changeTypes).toContain(TemplateChangeType.CLEAN_JOBS);

    const toFalse = tracker.process(makeData({ job_id: 'j3', timestamp: '2024-01-01T00:00:02.000', clean_jobs: false }));
    expect(toFalse.changeTypes).not.toContain(TemplateChangeType.CLEAN_JOBS);
  });

  test('per-pool isolation', () => {
    const tracker = createTemplateChangeTracker();
    tracker.process(makeData({ pool_name: 'PoolA' }));
    tracker.process(makeData({ pool_name: 'PoolB' }));

    const resultB = tracker.process(makeData({
      pool_name: 'PoolB',
      job_id: 'job2',
      timestamp: '2024-01-01T00:00:01.000',
      height: 101,
    }));
    expect(resultB.changeDetails.height).toEqual({ old: 100, new: 101 });
  });

  // BUG 1: reprocessing the same message used to re-diff it against whatever
  // the baseline happened to be at that moment, so a message could report
  // different changes on a re-render than it did when it first arrived.
  test('reprocessing an identical message is idempotent (returns its original diff)', () => {
    const tracker = createTemplateChangeTracker();
    tracker.process(makeData());
    const msg = makeData({ job_id: 'job2', timestamp: '2024-01-01T00:00:01.000', height: 101 });
    const first = tracker.process(msg);
    expect(first.changeTypes).toContain(TemplateChangeType.HEIGHT);

    // Feed a third message so the baseline moves past job2.
    tracker.process(makeData({ job_id: 'job3', timestamp: '2024-01-01T00:00:02.000', height: 102 }));
    // Re-feeding job2 must return the SAME diff it originally produced
    // (against job1), not a new diff against job3 and not an empty one.
    const replay = tracker.process(msg);
    expect(replay.changeTypes).toEqual(first.changeTypes);
    expect(replay.changeDetails).toEqual(first.changeDetails);
  });

  // BUG 2: a duplicate job_id with *different* content (common when a pool
  // re-sends a job after changing transactions) was silently swallowed.
  test('duplicate job_id with changed content surfaces content changes', () => {
    const tracker = createTemplateChangeTracker();
    tracker.process(makeData());

    const result = tracker.process(makeData({
      timestamp: '2024-01-01T00:00:01.000',
      merkle_branches: ['zzzz', 'bbbb'], // same job_id, different tx set
    }));
    expect(result.changeTypes).toContain(TemplateChangeType.MERKLE_BRANCHES);
  });

  test('duplicate job_id with identical content reports no changes', () => {
    const tracker = createTemplateChangeTracker();
    tracker.process(makeData());
    const result = tracker.process(makeData({ timestamp: '2024-01-01T00:00:01.000' }));
    expect(result.hasChanges).toBe(true);
    expect(result.changeTypes).toHaveLength(0);
  });

  // BUG 3: out-of-order delivery (an older template arriving after a newer
  // one) polluted the baseline and produced garbage diffs.
  test('out-of-order older template does not corrupt the baseline', () => {
    const tracker = createTemplateChangeTracker();
    tracker.process(makeData({ job_id: 'job1' }));
    tracker.process(makeData({ job_id: 'job2', timestamp: '2024-01-01T00:00:02.000' }));

    // An older template arrives late (timestamp between job1 and job2).
    const late = tracker.process(makeData({ job_id: 'job1b', timestamp: '2024-01-01T00:00:01.000', version: '20000001' }));
    expect(late.outOfOrder).toBe(true);

    // Baseline must still be job2, so the next in-order template compares
    // against job2, not against the late arrival (whose version differed).
    const next = tracker.process(makeData({ job_id: 'job3', timestamp: '2024-01-01T00:00:03.000', merkle_branches: ['zzzz', 'bbbb'] }));
    expect(next.changeTypes).toContain(TemplateChangeType.MERKLE_BRANCHES);
    expect(next.changeTypes).not.toContain(TemplateChangeType.VERSION);
    expect(next.changeTypes).not.toContain(TemplateChangeType.HEIGHT);
  });

  test('baseline resets when height regresses (new chain tip / block switch)', () => {
    const tracker = createTemplateChangeTracker();
    tracker.process(makeData({ height: 100 }));
    tracker.process(makeData({ job_id: 'job2', timestamp: '2024-01-01T00:00:01.000', height: 101 }));

    // Height going backwards means a new block was found and we switched to a
    // different height view; treat the next template as a fresh baseline.
    const result = tracker.process(makeData({ job_id: 'job3', timestamp: '2024-01-01T00:00:02.000', height: 99 }));
    expect(result.changeTypes).toHaveLength(0);
  });

  // BUG 4: result-cache eviction used to cause re-computation against the
  // *current* baseline rather than the baseline the message originally saw.
  test('processing is sequential: eviction cannot change a message result', () => {
    const tracker = createTemplateChangeTracker();
    tracker.process(makeData());

    // Push more than MAX_TRACKED_JOBS_PER_POOL messages through one pool.
    let last;
    for (let i = 0; i < 120; i++) {
      last = tracker.process(makeData({
        job_id: `job-${i}`,
        timestamp: new Date(Date.parse(T0) + (i + 1) * 1000).toISOString(),
        height: 100,
        version: i % 2 === 0 ? '20000000' : '20000001',
      }));
    }
    // The final message must be compared against its immediate predecessor,
    // regardless of how much internal bookkeeping was evicted along the way.
    expect(last).toBeDefined();
    expect(last!.changeTypes).toContain(TemplateChangeType.VERSION);
    expect(last!.changeDetails.version).toEqual({ old: '20000000', new: '20000001' });
  });

  // BUG 5: the old processor cache key omitted merkle_branches/height/etc., so
  // two messages sharing coinbase but differing in those fields got the first
  // message's processed data.
  test('same coinbase but different merkle branches still detects the change', () => {
    const tracker = createTemplateChangeTracker();
    tracker.process(makeData());
    const result = tracker.process(makeData({
      job_id: 'job2',
      timestamp: '2024-01-01T00:00:01.000',
      merkle_branches: ['dddd', 'eeee'],
    }));
    expect(result.changeTypes).toContain(TemplateChangeType.MERKLE_BRANCHES);
    expect(result.changeDetails.merkleBranches?.new).toEqual(['dddd', 'eeee']);
  });

  test('same coinbase but different height still detects the change', () => {
    const tracker = createTemplateChangeTracker();
    tracker.process(makeData());
    const result = tracker.process(makeData({
      job_id: 'job2',
      timestamp: '2024-01-01T00:00:01.000',
      height: 101,
    }));
    expect(result.changeTypes).toContain(TemplateChangeType.HEIGHT);
    expect(result.changeDetails.height).toEqual({ old: 100, new: 101 });
  });

  test('OP_RETURN protocol changes are surfaced with per-protocol change types', () => {
    const tracker = createTemplateChangeTracker();
    tracker.process(makeData());
    // Swap the OP_RETURN payload: 'deadbeefcafebabe' (Unknown, not tracked)
    // -> a proper RSK Block payload (0x29 = 41-byte push: 9-byte marker + 32B hash).
    const rskCb2 = 'ffffffff0100000000000000002b6a2952534b424c4f434b3a' +
      '1111111111111111111111111111111111111111111111111111111111111111' +
      '00000000';
    const result = tracker.process(makeData({ job_id: 'job2', timestamp: '2024-01-01T00:00:01.000', coinbase2: rskCb2 }));
    expect(result.changeTypes).toContain(TemplateChangeType.OP_RETURN_RSK);
  });

  // Regression test for the live-stream symptom "all bars gray": the stream
  // buffer keeps only the latest template per pool+height and re-feeds the
  // whole buffer to the chart every second. Each template must keep the diff
  // computed against its chronological predecessor across those replays.
  test('live stream re-feed keeps each template\u2019s diff stable across replays', () => {
    const tracker = createTemplateChangeTracker();
    tracker.process(makeData({ job_id: 'A', timestamp: '2024-01-01T00:00:00.000' }));

    const B = makeData({ job_id: 'B', timestamp: '2024-01-01T00:00:01.000', merkle_branches: ['zzzz', 'bbbb'] });
    const firstB = tracker.process(B);
    expect(firstB.changeTypes).toContain(TemplateChangeType.MERKLE_BRANCHES);

    // B is now the baseline and gets re-fed on the next render. It must still
    // report its original merkle-branch change.
    const replayB = tracker.process(B);
    expect(replayB.changeTypes).toContain(TemplateChangeType.MERKLE_BRANCHES);
    expect(replayB.changeTypes).toEqual(firstB.changeTypes);
  });

  test('reset() clears all per-pool baselines', () => {
    const tracker = createTemplateChangeTracker();
    tracker.process(makeData());
    tracker.reset();
    const result = tracker.process(makeData({ job_id: 'job2', timestamp: '2024-01-01T00:00:01.000', height: 101 }));
    expect(result.changeTypes).toHaveLength(0);
  });
});

describe('getChangeTypeDisplay', () => {
  test('empty for no changes', () => {
    expect(getChangeTypeDisplay([])).toBe('');
  });

  test('single visible change renders its letter', () => {
    expect(getChangeTypeDisplay([TemplateChangeType.MERKLE_BRANCHES])).toBe('M');
  });

  test('hidden change types are filtered from display', () => {
    expect(getChangeTypeDisplay([TemplateChangeType.NTIME])).toBe('');
    expect(getChangeTypeDisplay([TemplateChangeType.COINBASE_OUTPUT_VALUE])).toBe('');
    expect(getChangeTypeDisplay([TemplateChangeType.OP_RETURN_WITNESS])).toBe('');
    expect(getChangeTypeDisplay([TemplateChangeType.COINBASE_ASCII])).toBe('');
  });

  test('multiple visible changes are combined and deduplicated', () => {
    const display = getChangeTypeDisplay([
      TemplateChangeType.PREV_HASH,
      TemplateChangeType.MERKLE_BRANCHES,
      TemplateChangeType.MERKLE_BRANCHES,
    ]);
    expect(display).toBe('MP');
  });
});
