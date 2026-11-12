import { describe, expect, it } from 'vitest';
import {
  TemplateBuffer, chartWindow, latestPerPool, liveSinceMs, templateKey, timestampMicros, withOrigin,
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
    const fromMongo = { ...live, job_id: undefined as unknown as string };
    const fromPostgres = { ...live, timestamp: hexNsFromPostgres(5) };
    expect(templateKey(live)).toBe(templateKey(fromMongo));
    expect(templateKey(live)).toBe(templateKey(fromPostgres));
  });

  it('keeps two templates from one pool in the same microsecond (one socket read) apart', () => {
    const a = tpl('A', 100, 5, { ntime: '69d72a43', coinbase1: '01aa', coinbase2: 'ff01' });
    const b = tpl('A', 100, 5, { ntime: '69d72a44', coinbase1: '01aa', coinbase2: 'ff02' });
    expect(templateKey(a)).not.toBe(templateKey(b));
    const buffer = new TemplateBuffer();
    buffer.setTip(99);
    expect(buffer.add([a, b], 'live')).toBe(2);
  });

  it('ignores hex case (Postgres returns lower-case, MongoDB keeps the pool\'s casing)', () => {
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
    expect(buffer.add([tpl('A', 100, 30), tpl('B', 100, 40)], 'live')).toBe(2);
    // …the pre-fill (Postgres timestamps, no job_id) overlaps with one of them and adds older history.
    const prefill = [
      { ...tpl('A', 100, 10), timestamp: hexNsFromPostgres(10) },
      { ...tpl('A', 100, 30), timestamp: hexNsFromPostgres(30), job_id: undefined as unknown as string },
      { ...tpl('B', 100, 20), timestamp: hexNsFromPostgres(20) },
    ];
    expect(buffer.add(prefill, 'prefill')).toBe(2);
    // …then the stream repeats nothing new.
    expect(buffer.add([tpl('B', 100, 40)], 'live')).toBe(0);

    const entries = buffer.entries();
    expect(entries.map(e => `${e.data.pool_name}@${e.timeMs - BASE_MS}:${e.origin}`)).toEqual([
      'A@10:prefill', 'B@20:prefill', 'A@30:live', 'B@40:live',
    ]);
  });

  it('marks a pre-filled template live when the stream delivers it too', () => {
    const buffer = new TemplateBuffer();
    buffer.add([tpl('A', 100, 10)], 'prefill');
    const before = buffer.version;
    expect(buffer.add([tpl('A', 100, 10)], 'live')).toBe(0);
    expect(buffer.entries()[0].origin).toBe('live');
    expect(buffer.version).toBeGreaterThan(before);
    // A live template arriving again as pre-fill stays live.
    buffer.add([tpl('A', 100, 10)], 'prefill');
    expect(buffer.entries()[0].origin).toBe('live');
  });

  it('bumps the epoch only for out-of-order arrivals, so incremental consumers know to rebuild', () => {
    const buffer = new TemplateBuffer();
    buffer.add([tpl('A', 100, 30)], 'live');
    const epoch = buffer.epoch;
    buffer.add([tpl('A', 100, 40), tpl('B', 100, 5)], 'live'); // B is new: not out of order
    expect(buffer.epoch).toBe(epoch);
    buffer.add([tpl('A', 100, 10)], 'prefill'); // older than A@40
    expect(buffer.epoch).toBe(epoch + 1);
  });

  it('assigns increasing seq numbers so consumers can process only what is new', () => {
    const buffer = new TemplateBuffer();
    buffer.add([tpl('A', 100, 10)], 'live');
    const lastSeq = Math.max(...buffer.entries().map(e => e.seq));
    buffer.add([tpl('B', 100, 5)], 'prefill');
    const fresh = buffer.entries().filter(e => e.seq > lastSeq);
    expect(fresh.map(e => e.data.pool_name)).toEqual(['B']);
  });

  it('skips other chains\' templates (chain_family set) and pools rejected by the filter', () => {
    const buffer = new TemplateBuffer();
    buffer.add([
      tpl('A', 100, 1),
      tpl('A', 6_976_415, 2, { chain_family: 'unknown' }),
      tpl('Hidden', 100, 3),
    ], 'prefill', pool => pool !== 'Hidden');
    expect(buffer.entries().map(e => e.data.pool_name)).toEqual(['A']);
    expect(buffer.currentHeight).toBe(100);
  });
});

describe('TemplateBuffer window trimming', () => {
  it('keeps the current height and the two before it', () => {
    const buffer = new TemplateBuffer({ heights: 3 });
    buffer.setTip(99);
    buffer.add([tpl('A', 98, 1), tpl('A', 99, 2), tpl('A', 100, 3)], 'prefill');
    expect(buffer.entries().map(e => e.data.height)).toEqual([98, 99, 100]);

    // A new block moves the window: 98 drops out.
    buffer.setTip(100);
    expect(buffer.currentHeight).toBe(101);
    expect(buffer.entries().map(e => e.data.height)).toEqual([99, 100]);

    // Templates below the window are not added.
    expect(buffer.add([tpl('B', 98, 4)], 'live')).toBe(0);
  });

  it('follows templates ahead of the tip (a block the backend has not seen yet)', () => {
    const buffer = new TemplateBuffer({ heights: 2 });
    buffer.setTip(99);
    buffer.add([tpl('A', 99, 1), tpl('A', 100, 2), tpl('A', 101, 3)], 'live');
    expect(buffer.currentHeight).toBe(101);
    expect(buffer.entries().map(e => e.data.height)).toEqual([100, 101]);
  });

  it('ignores heights far above the tip, so a stray height cannot empty the window', () => {
    const buffer = new TemplateBuffer();
    buffer.setTip(99);
    buffer.add([tpl('A', 100, 1), tpl('X', 6_976_415, 2)], 'live');
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
    buffer.add([tpl('A', 100, 1), tpl('B', 100, 2), tpl('C', 100, 3), tpl('D', 100, 4), tpl('E', 100, 5)], 'live');
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
  ], 'prefill');
  buffer.add([tpl('C', 100, 80)], 'live');
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

  it('liveSinceMs: the first template that arrived over the stream', () => {
    expect(liveSinceMs(entries)).toBe(BASE_MS + 80);
    expect(liveSinceMs(entries.filter(e => e.origin === 'prefill'))).toBeNull();
  });

  it('withOrigin carries the origin onto the template', () => {
    expect(withOrigin(entries[0]).origin).toBe('prefill');
    expect(withOrigin(entries[entries.length - 1]).origin).toBe('live');
  });
});
