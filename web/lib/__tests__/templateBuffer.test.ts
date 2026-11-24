import { describe, expect, it } from 'vitest';
import {
  TemplateBuffer, chartWindow, latestPerPool, templateKey, timestampMicros,
} from '../templateBuffer';
import type { StratumV1Data } from '../types';

const BASE_MS = 1_794_513_910_000; // a realistic receive time (ms since the epoch)

/** Collector-style hex-nanosecond timestamp for BASE_MS + offset, with sub-µs digits (as the stream sends). */
function hexNs(offsetMs: number, subMicroNs = 123): string {
  return ((BigInt(BASE_MS + offsetMs) * BigInt(1_000_000)) + BigInt(subMicroNs)).toString(16);
}

/** The same receive time as Postgres returns it: µs precision, last three ns digits zero. */
function hexNsFromPostgres(offsetMs: number): string {
  return hexNs(offsetMs, 0);
}

function tpl(pool: string, height: number, offsetMs: number, extra: Partial<StratumV1Data> = {}): StratumV1Data {
  return {
    pool_name: pool,
    timestamp: hexNs(offsetMs),
    job_id: `${pool}-${offsetMs}`,
    height,
    prev_hash: '00',
    version: '20000000',
    coinbase1: '',
    coinbase2: '',
    extranonce1: '',
    extranonce2_length: 8,
    clean_jobs: false,
    first_transaction: '',
    fee_rate: '',
    merkle_branches: [],
    ...extra,
  };
}

describe('templateKey', () => {
  it('matches stream (ns) and Postgres (µs) forms of the same receive time, without job_id', () => {
    const live = tpl('A', 100, 5);
    const withoutJobId = { ...live, job_id: undefined as unknown as string };
    const fromPostgres = { ...live, timestamp: hexNsFromPostgres(5) };
    expect(templateKey(live)).toBe(templateKey(withoutJobId));
    expect(templateKey(live)).toBe(templateKey(fromPostgres));
  });

  it('keeps two templates from one pool in the same microsecond (one socket read) apart', () => {
    const a = tpl('A', 100, 5, { ntime: '69d72a43', coinbase1: '01aa', coinbase2: 'ff01' });
    const b = tpl('A', 100, 5, { ntime: '69d72a44', coinbase1: '01aa', coinbase2: 'ff02' });
    expect(templateKey(a)).not.toBe(templateKey(b));
    const buffer = new TemplateBuffer();
    buffer.setTip(99);
    expect(buffer.add([a, b])).toBe(2);
  });

  it('ignores hex case (Postgres returns lower-case, the stream keeps the pool\'s casing)', () => {
    const live = tpl('A', 100, 5, { ntime: '69D72A43', coinbase1: '01AA', coinbase2: 'FF01' });
    const fromPostgres = { ...live, timestamp: hexNsFromPostgres(5), ntime: '69d72a43', coinbase1: '01aa', coinbase2: 'ff01' };
    expect(templateKey(live)).toBe(templateKey(fromPostgres));
  });

  it('differs by pool and by microsecond', () => {
    expect(templateKey(tpl('A', 100, 5))).not.toBe(templateKey(tpl('B', 100, 5)));
    expect(templateKey(tpl('A', 100, 5))).not.toBe(templateKey(tpl('A', 100, 6)));
  });

  it('rejects malformed timestamps and missing pools', () => {
    expect(templateKey({ pool_name: 'A', timestamp: 'not-hex' })).toBeNull();
    expect(templateKey({ pool_name: '', timestamp: hexNs(1) })).toBeNull();
    expect(timestampMicros('0x' + hexNs(1))).toBe(timestampMicros(hexNs(1)));
  });
});

describe('TemplateBuffer merge and de-duplication', () => {
  it('merges overlapping pre-fill and stream data without duplicates, in time order', () => {
    const buffer = new TemplateBuffer();
    buffer.setTip(99);
    // The stream delivers two templates before the pre-fill lands…
    expect(buffer.add([tpl('A', 100, 30), tpl('B', 100, 40)])).toBe(2);
    // …the pre-fill (Postgres timestamps, no job_id) overlaps with one of them and adds older history.
    const prefill = [
      { ...tpl('A', 100, 10), timestamp: hexNsFromPostgres(10) },
      { ...tpl('A', 100, 30), timestamp: hexNsFromPostgres(30), job_id: undefined as unknown as string },
      { ...tpl('B', 100, 20), timestamp: hexNsFromPostgres(20) },
    ];
    expect(buffer.add(prefill)).toBe(2);
    // …then the stream repeats nothing new.
    expect(buffer.add([tpl('B', 100, 40)])).toBe(0);

    const entries = buffer.entries();
    expect(entries.map(e => `${e.data.pool_name}@${e.timeMs - BASE_MS}`)).toEqual(['A@10', 'B@20', 'A@30', 'B@40']);
  });

  it('ignores a pre-filled template the stream delivers too, without a change notification', () => {
    const buffer = new TemplateBuffer();
    buffer.add([tpl('A', 100, 10)]);
    const before = buffer.version;
    expect(buffer.add([tpl('A', 100, 10)])).toBe(0);
    expect(buffer.entries()).toHaveLength(1);
    expect(buffer.version).toBe(before);
  });

  it('bumps the epoch only for out-of-order arrivals, so incremental consumers know to rebuild', () => {
    const buffer = new TemplateBuffer();
    buffer.add([tpl('A', 100, 30)]);
    const epoch = buffer.epoch;
    buffer.add([tpl('A', 100, 40), tpl('B', 100, 5)]); // B is new: not out of order
    expect(buffer.epoch).toBe(epoch);
    buffer.add([tpl('A', 100, 10)]); // older than A@40
    expect(buffer.epoch).toBe(epoch + 1);
  });

  it('assigns increasing seq numbers so consumers can process only what is new', () => {
    const buffer = new TemplateBuffer();
    buffer.add([tpl('A', 100, 10)]);
    const lastSeq = Math.max(...buffer.entries().map(e => e.seq));
    buffer.add([tpl('B', 100, 5)]);
    const fresh = buffer.entries().filter(e => e.seq > lastSeq);
    expect(fresh.map(e => e.data.pool_name)).toEqual(['B']);
  });

  it('skips pools rejected by the filter', () => {
    const buffer = new TemplateBuffer();
    buffer.add([
      tpl('A', 100, 1),
      tpl('Hidden', 100, 3),
    ], pool => pool !== 'Hidden');
    expect(buffer.entries().map(e => e.data.pool_name)).toEqual(['A']);
    expect(buffer.currentHeight).toBe(100);
  });
});

describe('TemplateBuffer window trimming', () => {
  it('keeps the current height and the two before it', () => {
    const buffer = new TemplateBuffer({ heights: 3 });
    buffer.setTip(99);
    buffer.add([tpl('A', 98, 1), tpl('A', 99, 2), tpl('A', 100, 3)]);
    expect(buffer.entries().map(e => e.data.height)).toEqual([98, 99, 100]);

    // A new block moves the window: 98 drops out.
    buffer.setTip(100);
    expect(buffer.currentHeight).toBe(101);
    expect(buffer.entries().map(e => e.data.height)).toEqual([99, 100]);

    // Templates below the window are not added.
    expect(buffer.add([tpl('B', 98, 4)])).toBe(0);
  });

  it('follows templates ahead of the tip (a block the backend has not seen yet)', () => {
    const buffer = new TemplateBuffer({ heights: 2 });
    buffer.setTip(99);
    buffer.add([tpl('A', 99, 1), tpl('A', 100, 2), tpl('A', 101, 3)]);
    expect(buffer.currentHeight).toBe(101);
    expect(buffer.entries().map(e => e.data.height)).toEqual([100, 101]);
  });

  it('ignores heights far above the tip, so a stray height cannot empty the window', () => {
    const buffer = new TemplateBuffer();
    buffer.setTip(99);
    buffer.add([tpl('A', 100, 1), tpl('X', 6_976_415, 2)]);
    expect(buffer.currentHeight).toBe(100);
    expect(buffer.entries().map(e => e.data.pool_name)).toEqual(['A']);
  });

  it('never moves the tip backwards (re-indexed old blocks)', () => {
    const buffer = new TemplateBuffer();
    buffer.setTip(100);
    expect(buffer.setTip(90)).toBe(false);
    expect(buffer.tipHeight).toBe(100);
  });

  it('caps rows, dropping the oldest first', () => {
    const buffer = new TemplateBuffer({ maxRows: 3 });
    buffer.add([tpl('A', 100, 1), tpl('B', 100, 2), tpl('C', 100, 3), tpl('D', 100, 4), tpl('E', 100, 5)]);
    expect(buffer.size).toBe(3);
    expect(buffer.entries().map(e => e.data.pool_name)).toEqual(['C', 'D', 'E']);
  });
});

describe('per-visual selectors', () => {
  const buffer = new TemplateBuffer();
  buffer.setTip(99);
  buffer.add([
    tpl('A', 99, 1),
    tpl('B', 99, 2),
    tpl('A', 100, 50),
    tpl('A', 100, 70),
    tpl('C', 100, 60),
  ]);
  buffer.add([tpl('C', 100, 80)]);
  const entries = buffer.entries();

  it('latestPerPool: each pool\'s latest template, oldest first', () => {
    expect(latestPerPool(entries).map(e => `${e.data.pool_name}@${e.timeMs - BASE_MS}`))
      .toEqual(['B@2', 'A@70', 'C@80']);
  });

  it('latestPerPool: minHeight drops pools with nothing recent enough', () => {
    expect(latestPerPool(entries, { minHeight: 100 }).map(e => e.data.pool_name)).toEqual(['A', 'C']);
  });

  it('applies the pool filter to pre-filled rows exactly like live ones', () => {
    const isPoolVisible = (pool: string) => pool !== 'A';
    expect(latestPerPool(entries, { isPoolVisible }).map(e => e.data.pool_name)).toEqual(['B', 'C']);
    expect(chartWindow(entries, BASE_MS, { isPoolVisible }).every(e => e.data.pool_name !== 'A')).toBe(true);
  });

  it('chartWindow: everything after the cutoff plus each pool\'s last template before it', () => {
    expect(chartWindow(entries, BASE_MS + 55).map(e => `${e.data.pool_name}@${e.timeMs - BASE_MS}`))
      .toEqual(['B@2', 'A@50', 'C@60', 'A@70', 'C@80']);
  });
});

describe('entry identity', () => {
  it('keeps the same entry and template object across snapshots, so consumers can cache per template', () => {
    const buffer = new TemplateBuffer();
    buffer.setTip(99);
    buffer.add([tpl('A', 100, 1), tpl('B', 100, 2)]);
    const first = buffer.entries();
    buffer.add([tpl('C', 100, 3)]);
    // The stream repeating a buffered template doesn't replace it either.
    buffer.add([tpl('A', 100, 1)]);
    const second = buffer.entries();
    expect(second).not.toBe(first);
    expect(second[0]).toBe(first[0]);
    expect(second[0].data).toBe(first[0].data);
    expect(second[1].data).toBe(first[1].data);
  });
});

describe('other-chain templates (collectors don\'t tag them)', () => {
  it('are kept out by the tip bounds: far above the tip, and below the kept height range', () => {
    const buf = new TemplateBuffer({ heights: 3 });
    buf.setTip(976_400);
    const added = buf.add([
      tpl('btc', 976_401, 1),
      tpl('other-high', 6_976_415, 2),   // another chain's height far above Bitcoin's
      tpl('other-low', 915_000, 3),      // another chain far below the kept range
    ]);
    expect(added).toBe(1);
    expect(buf.entries().map(e => e.data.pool_name)).toEqual(['btc']);
  });

  it('one that arrives before the first tip is pruned when the tip arrives, and Bitcoin work comes back', () => {
    const buf = new TemplateBuffer({ heights: 3 });
    buf.add([tpl('other-high', 6_976_415, 1)]);      // the live stream can beat the pre-fill's tip
    buf.setTip(976_400);
    expect(buf.entries()).toEqual([]);
    expect(buf.add([tpl('btc', 976_401, 2)])).toBe(1); // the pre-fill (or the next live template) is accepted
    expect(buf.currentHeight).toBe(976_401);
  });
});

describe('gaps (change detection must not compare across missed templates)', () => {
  const gapOf = (b: TemplateBuffer, job: string) => b.entries().find(e => e.data.job_id === job)?.gapBefore === true;

  it('marks only the next template of a throttled pool', () => {
    const b = new TemplateBuffer();
    b.add([tpl('A', 100, 0), tpl('B', 100, 1)]);
    b.markGap('A');
    b.add([tpl('A', 100, 10), tpl('B', 100, 11), tpl('A', 100, 20)]);
    expect(gapOf(b, 'A-10')).toBe(true);
    expect(gapOf(b, 'B-11')).toBe(false);
    expect(gapOf(b, 'A-20')).toBe(false);
  });

  it('marks the next template of every pool after a pause or reconnect, and not a pool seen for the first time', () => {
    const b = new TemplateBuffer();
    b.add([tpl('A', 100, 0), tpl('B', 100, 1)]);
    b.markGap();
    b.add([tpl('A', 100, 10), tpl('C', 100, 12)]);
    b.add([tpl('B', 100, 15), tpl('A', 100, 20)]);
    expect(gapOf(b, 'A-10')).toBe(true);
    expect(gapOf(b, 'B-15')).toBe(true);
    expect(gapOf(b, 'C-12')).toBe(false);
    expect(gapOf(b, 'A-20')).toBe(false);
  });

  it('does not mark an older template arriving late (the pre-fill)', () => {
    const b = new TemplateBuffer();
    b.add([tpl('A', 100, 10)]);
    b.markGap('A');
    b.add([tpl('A', 100, 5)]);
    expect(gapOf(b, 'A-5')).toBe(false);
    b.add([tpl('A', 100, 20)]);
    expect(gapOf(b, 'A-20')).toBe(true);
  });

  it('keys a history row on its own receive time, so the stream copy of the same template is not buffered twice', () => {
    const b = new TemplateBuffer();
    // History: shown with the first-seen time of a copy on another connection (earlier), plus its own receive time.
    b.add([tpl('A', 100, 10, { timestamp: hexNsFromPostgres(8), received_timestamp: hexNsFromPostgres(10) })]);
    b.add([tpl('A', 100, 10)]); // the live stream: its own receive time
    expect(b.size).toBe(1);
  });
});
