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
  const live = (b: TemplateBuffer, t: StratumV1Data[]) => b.add(t, undefined, { live: true });

  it('marks only the next live template of a throttled pool', () => {
    const b = new TemplateBuffer();
    live(b, [tpl('A', 100, 0), tpl('B', 100, 1)]);
    b.markGap('A');
    live(b, [tpl('A', 100, 10), tpl('B', 100, 11), tpl('A', 100, 20)]);
    expect(gapOf(b, 'A-10')).toBe(true);
    expect(gapOf(b, 'B-11')).toBe(false);
    expect(gapOf(b, 'A-20')).toBe(false);
  });

  it('marks the next live template of every pool after a pause or reconnect, not a pool seen for the first time', () => {
    const b = new TemplateBuffer();
    live(b, [tpl('A', 100, 0), tpl('B', 100, 1)]);
    b.markGap();
    live(b, [tpl('A', 100, 10), tpl('C', 100, 12)]);
    live(b, [tpl('B', 100, 15), tpl('A', 100, 20)]);
    expect(gapOf(b, 'A-10')).toBe(true);
    expect(gapOf(b, 'B-15')).toBe(true);
    expect(gapOf(b, 'C-12')).toBe(false);
    expect(gapOf(b, 'A-20')).toBe(false);
  });

  it('the first live template after the pre-fill follows a gap unless the two share a template', () => {
    const b = new TemplateBuffer();
    b.add([tpl('A', 100, 0), tpl('A', 100, 5)]); // pre-fill
    live(b, [tpl('A', 100, 10), tpl('A', 100, 20)]);
    expect(gapOf(b, 'A-5')).toBe(false);
    expect(gapOf(b, 'A-10')).toBe(true); // nothing proves A-5 and A-10 were consecutive
    expect(gapOf(b, 'A-20')).toBe(false);

    const c = new TemplateBuffer();
    c.add([tpl('A', 100, 0), tpl('A', 100, 5)]);
    live(c, [tpl('A', 100, 5), tpl('A', 100, 10)]); // A-5 arrived from both: the stream saw A-5 then A-10
    expect(gapOf(c, 'A-10')).toBe(false);
  });

  it('a pre-fill landing after the first live templates: the seam is judged then (and the epoch bumps to rebuild)', () => {
    const b = new TemplateBuffer();
    live(b, [tpl('A', 100, 10), tpl('A', 100, 20)]);
    expect(gapOf(b, 'A-10')).toBe(false); // nothing before it yet
    const epoch = b.epoch;
    b.add([tpl('A', 100, 0), tpl('A', 100, 5)]);
    expect(gapOf(b, 'A-10')).toBe(true);
    expect(b.epoch).toBeGreaterThan(epoch);

    const c = new TemplateBuffer();
    live(c, [tpl('A', 100, 10), tpl('A', 100, 20)]);
    c.add([tpl('A', 100, 5), tpl('A', 100, 10)]); // the read has A-5 and A-10: consecutive
    expect(gapOf(c, 'A-10')).toBe(false);
  });

  it('a later history read that has both sides of the seam closes it, and the epoch bumps so the chart rebuilds', () => {
    const b = new TemplateBuffer();
    b.add([tpl('A', 100, 0), tpl('A', 100, 5)]);
    live(b, [tpl('A', 100, 10), tpl('A', 100, 20)]);
    expect(gapOf(b, 'A-10')).toBe(true);
    const epoch = b.epoch;
    b.add([tpl('A', 100, 0), tpl('A', 100, 5), tpl('A', 100, 10)]); // the database caught up to A-10
    expect(gapOf(b, 'A-10')).toBe(false);
    expect(b.epoch).toBe(epoch + 1);
    expect(b.pendingGaps(60_000)).toBe(0);
  });

  it('a history read fills in the templates a reconnect missed', () => {
    const b = new TemplateBuffer();
    live(b, [tpl('A', 100, 0)]);
    b.markGap(); // stream dropped
    live(b, [tpl('A', 100, 30)]);
    expect(gapOf(b, 'A-30')).toBe(true);
    expect(b.add([tpl('A', 100, 0), tpl('A', 100, 10), tpl('A', 100, 20), tpl('A', 100, 30)])).toBe(2);
    expect(b.entries().map(e => [e.data.job_id, !!e.gapBefore])).toEqual([
      ['A-0', false], ['A-10', false], ['A-20', false], ['A-30', false],
    ]);
  });

  it('a read that does not reach back to the last template before the gap moves the gap to its oldest row', () => {
    const b = new TemplateBuffer();
    live(b, [tpl('A', 100, 0)]);
    b.markGap();
    live(b, [tpl('A', 100, 30)]);
    const gaps = b.gapVersion;
    b.add([tpl('A', 100, 20), tpl('A', 100, 30)]); // A-0 is older than the read covers
    expect(gapOf(b, 'A-20')).toBe(true); // A-0 -> A-20 unproven
    expect(gapOf(b, 'A-30')).toBe(false); // A-20 -> A-30 is in the read
    expect(b.gapVersion).toBeGreaterThan(gaps);
  });

  it('a read the database has not caught up for leaves the newest live template after the gap open', () => {
    const b = new TemplateBuffer();
    live(b, [tpl('A', 100, 0)]);
    b.markGap();
    live(b, [tpl('A', 100, 30)]);
    b.add([tpl('A', 100, 0), tpl('A', 100, 10)]); // A-30 not written yet
    expect(gapOf(b, 'A-10')).toBe(false);
    expect(gapOf(b, 'A-30')).toBe(true);
    expect(b.pendingGaps(60_000)).toBe(1);
    expect(b.pendingGaps(10)).toBe(1); // A-30 is the newest
    expect(b.pendingGaps(-1)).toBe(0);
  });

  it('links neighbours in receive order (own receive time), the order change detection compares in', () => {
    const b = new TemplateBuffer();
    // History row X: first seen at 8 on another connection, received on its own at 12. Live Y received at 10.
    b.add([tpl('A', 100, 12, { job_id: 'X', timestamp: hexNsFromPostgres(8), received_timestamp: hexNsFromPostgres(12) })]);
    live(b, [tpl('A', 100, 10, { job_id: 'Y' })]);
    expect(gapOf(b, 'Y')).toBe(false); // first in receive order
    expect(gapOf(b, 'X')).toBe(true); // Y (live) -> X (history): nothing saw both
  });

  it('a pre-fill landing late takes the gap onto the live template after it', () => {
    const b = new TemplateBuffer();
    live(b, [tpl('A', 100, 10)]);
    b.markGap(); // paused / stream error
    b.add([tpl('A', 100, 5), tpl('A', 100, 8)]); // older rows from the pre-fill
    expect(gapOf(b, 'A-5')).toBe(false);
    expect(gapOf(b, 'A-8')).toBe(false);
    expect(gapOf(b, 'A-10')).toBe(true); // A-8 (read) -> A-10 (stream): nothing saw both
    live(b, [tpl('A', 100, 20)]);
    expect(gapOf(b, 'A-20')).toBe(true);
  });

  it('keys a history row on its own receive time, so the stream copy of the same template is not buffered twice', () => {
    const b = new TemplateBuffer();
    // History: shown with the first-seen time of a copy on another connection (earlier), plus its own receive time.
    b.add([tpl('A', 100, 10, { timestamp: hexNsFromPostgres(8), received_timestamp: hexNsFromPostgres(10) })]);
    live(b, [tpl('A', 100, 10)]); // the live stream: its own receive time
    expect(b.size).toBe(1);
  });
});

describe('templates left out between two others', () => {
  const gaps = (b: TemplateBuffer) => b.entries().filter(e => e.gapBefore).map(e => e.data.job_id);

  it('a trimmed template between two kept ones leaves the later one a gap, permanently', () => {
    const b = new TemplateBuffer();
    b.setTip(99);
    // X at 100, a stale Y at 98 (the oldest kept height), Z at 100: one live run.
    for (const t of [tpl('A', 100, 0), tpl('A', 98, 10), tpl('A', 100, 20)]) b.add([t], undefined, { live: true });
    expect(gaps(b)).toEqual([]);
    const epoch = b.epoch;
    b.setTip(100); // 98 drops out of the kept heights
    expect(b.entries().map(e => e.data.job_id)).toEqual(['A-0', 'A-20']);
    expect(gaps(b)).toEqual(['A-20']);
    expect(b.epoch).toBeGreaterThan(epoch); // the flag changed on an entry already handed out
    b.add([tpl('A', 100, 0), tpl('A', 100, 20)]); // a read with both can't prove it: Y was between
    expect(gaps(b)).toEqual(['A-20']);
  });

  it('a live template below the kept heights starts a new run for its pool', () => {
    const b = new TemplateBuffer();
    b.setTip(100);
    b.add([tpl('A', 101, 0)], undefined, { live: true });
    b.add([tpl('A', 97, 10)], undefined, { live: true }); // below the kept heights: not added
    b.add([tpl('A', 101, 20)], undefined, { live: true });
    expect(b.entries().map(e => e.data.job_id)).toEqual(['A-0', 'A-20']);
    expect(gaps(b)).toEqual(['A-20']);
  });

  it('a history row below the kept heights splits the response for its pool', () => {
    const b = new TemplateBuffer();
    b.setTip(100);
    b.add([tpl('A', 101, 0), tpl('A', 97, 10), tpl('A', 101, 20), tpl('B', 101, 5), tpl('B', 101, 25)]);
    expect(gaps(b)).toEqual(['A-20']);
  });
});

describe('page load with the stream replay', () => {
  // The stream's replay (lib/streamHub.ts) reaches back past what the history read has, so the two overlap.
  const sent = Array.from({ length: 8 }, (_, i) => tpl('A', 100, i * 10));
  for (const order of ['history first', 'replay first']) {
    it(`no gap when the replay overlaps the history read (${order})`, () => {
      const b = new TemplateBuffer();
      const history = () => b.add(sent.slice(0, 5));
      if (order === 'history first') history();
      b.add(sent.slice(3, 7), undefined, { live: true }); // the replay
      b.add([sent[7]], undefined, { live: true });
      if (order === 'replay first') history();
      expect(b.entries().filter(e => e.gapBefore)).toEqual([]);
      expect(b.pendingGaps(Infinity)).toBe(0);
    });
  }

  it('a replay that does not reach the history read leaves the gap for a re-read', () => {
    const b = new TemplateBuffer();
    b.add(sent.slice(0, 3));
    b.add(sent.slice(4, 8), undefined, { live: true });
    expect(b.pendingGaps(Infinity)).toBe(1);
  });
});

describe('gaps: property test against a known sequence', () => {
  // A pool sends templates 0..N-1 on one connection. The page sees some of them live (with gaps it is told about:
  // pauses, reconnects, throttling) and some history reads (everything from a cutoff up to what the database has
  // written so far). Whatever happens, two neighbours not flagged gapBefore must be consecutive in what the pool sent.
  function rng(seed: number) {
    let x = seed >>> 0;
    return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  }

  it('never leaves two non-consecutive templates comparable, and a full read proves everything', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const N = 40;
      const sent = Array.from({ length: N }, (_, i) => tpl('A', 100, i * 10));
      const b = new TemplateBuffer();
      let streaming = r() < 0.5; // the stream may start before or after the pre-fill
      let written = 0; // the database has sent[0..written)
      let connecting = true; // the next live template is a new connection's first
      for (let i = 0; i < N; i++) {
        written = Math.max(written, Math.min(N, i - Math.floor(r() * 4))); // the database lags a few templates
        const roll = r();
        if (roll < 0.12) {
          b.markGap(r() < 0.5 ? undefined : 'A'); // a gap the page knows about; this template is missed
          streaming = true;
          connecting = true;
          continue;
        }
        if (roll < 0.2) {
          // A history read: from a cutoff (or the start) to what's written.
          const from = r() < 0.3 ? 0 : Math.max(0, written - 1 - Math.floor(r() * 10));
          b.add(sent.slice(from, written));
        }
        if (streaming && connecting) {
          // A new connection may start with the server's replay: the templates its consumer saw just before, a
          // contiguous stretch ending right before this one (app/api/stream, lib/streamHub.ts).
          connecting = false;
          if (r() < 0.6) b.add(sent.slice(Math.max(0, i - 1 - Math.floor(r() * 6)), i), undefined, { live: true });
        }
        if (streaming) b.add([sent[i]], undefined, { live: true });
        else if (r() < 0.3) streaming = true;
      }
      const byIndex = new Map(sent.map((t, i) => [t.job_id, i]));
      const check = () => {
        const list = b.entries().slice().sort((x, y) => x.recvMs - y.recvMs);
        for (let k = 1; k < list.length; k++) {
          if (list[k].gapBefore) continue;
          expect(byIndex.get(list[k].data.job_id)! - byIndex.get(list[k - 1].data.job_id)!, `seed ${seed} at ${k}`).toBe(1);
        }
      };
      check();
      b.add(sent); // a read that has everything
      check();
      expect(b.pendingGaps(Infinity), `seed ${seed}`).toBe(0);
    }
  });
});
