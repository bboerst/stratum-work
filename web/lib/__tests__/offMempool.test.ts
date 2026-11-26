/**
 * lib/offMempool.ts (#328): one test per no-data rule, so a recorder gap never reads as "never seen" and missing data
 * never reads as zero. Synthetic blocks and hashes.
 */
import { describe, expect, it } from 'vitest';
import {
  AFTER_GAP_BLOCKS, OFF_STATE, assembleOffMempool, formatRuns, leadIn, positionRuns, reverseHex,
  type ChainBlock, type RecordedBlock,
} from '../offMempool';

const H0 = 3_000_000;
const hash = (h: number) => h.toString(16).padStart(64, '0');
const chain = (from: number, to: number): ChainBlock[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ height: from + i, hash: hash(from + i), pool: 'P', time_s: 1_000 + i }));
const seen = (h: number) => 1_000_000 + (h - H0) * 600_000;   // a block every 10 minutes
function recorder(from: number, to: number, o: (h: number) => Partial<RecordedBlock> = () => ({})) {
  const m = new Map<string, RecordedBlock>();
  for (let h = from; h <= to; h++) {
    m.set(hash(h), { hash: hash(h), seen_ms: seen(h), tx_count: 101, off_mempool: 1, checked: true, ...o(h) });
  }
  return m;
}
const states = (rows: ReturnType<typeof assembleOffMempool>) => rows.map(r => r[4]);
const G = OFF_STATE.afterGap, OK = OFF_STATE.measured;

describe('assembleOffMempool', () => {
  it('has no rows before the record starts, and treats its start as a gap', () => {
    const rows = assembleOffMempool(chain(H0 - 5, H0 + 9), recorder(H0, H0 + 9), [], H0, H0 - 5);
    expect(rows[0][0]).toBe(H0);
    expect(states(rows)).toEqual([...Array(AFTER_GAP_BLOCKS).fill(G), ...Array(10 - AFTER_GAP_BLOCKS).fill(OK)]);
    expect(assembleOffMempool(chain(H0, H0 + 3), new Map(), [], null, H0)).toEqual([]);
  });

  it('measured rows carry transactions without the coinbase and the off-mempool count', () => {
    const rows = assembleOffMempool(chain(H0, H0 + 7), recorder(H0, H0 + 7, () => ({ off_mempool: 25 })), [], H0, H0);
    expect(rows[7]).toEqual([H0 + 7, 'P', 100, 25, OK, 1_007]);
  });

  it('a block with no recorder row is missed (null counts, not zero), and the next blocks are after a gap', () => {
    const rec = recorder(H0, H0 + 20);
    rec.delete(hash(H0 + 10));
    const rows = assembleOffMempool(chain(H0, H0 + 20), rec, [], H0, H0 + 8);
    const r10 = rows.find(r => r[0] === H0 + 10)!;
    expect(r10.slice(2, 5)).toEqual([null, null, OFF_STATE.missed]);
    expect(states(rows)).toEqual([OK, OK, OFF_STATE.missed, ...Array(AFTER_GAP_BLOCKS).fill(G), ...Array(4).fill(OK)]);
  });

  it('an unchecked row is no data, its count dropped, and starts a gap', () => {
    const rows = assembleOffMempool(chain(H0, H0 + 16), recorder(H0, H0 + 16, h => (h === H0 + 8 ? { checked: false, off_mempool: null } : {})), [], H0, H0 + 7);
    expect(rows[1].slice(3, 5)).toEqual([null, OFF_STATE.unchecked]);
    expect(states(rows)).toEqual([OK, OFF_STATE.unchecked, ...Array(AFTER_GAP_BLOCKS).fill(G), OK, OK]);
  });

  it('a resync with no missed block (the gap fell between two blocks) makes the next blocks after a gap', () => {
    const sync = seen(H0 + 10) - 1;                       // just before H0+10 connected
    const rows = assembleOffMempool(chain(H0, H0 + 20), recorder(H0, H0 + 20), [sync], H0, H0 + 8);
    expect(states(rows)).toEqual([OK, OK, ...Array(AFTER_GAP_BLOCKS).fill(G), ...Array(5).fill(OK)]);
    // a resync at the very instant of the connect counts too
    const at = assembleOffMempool(chain(H0, H0 + 20), recorder(H0, H0 + 20), [seen(H0 + 10)], H0, H0 + 10);
    expect(at[0][4]).toBe(G);
  });

  it('the range start is not a gap: a lead-in of AFTER_GAP_BLOCKS blocks decides', () => {
    const from = H0 + 100;
    expect(leadIn(from, H0)).toBe(from - AFTER_GAP_BLOCKS);
    expect(leadIn(H0 + 2, H0)).toBe(H0);
    const lo = leadIn(from, H0);
    const rows = assembleOffMempool(chain(lo, from + 5), recorder(lo, from + 5), [], H0, from);
    expect(rows[0][0]).toBe(from);
    expect(states(rows).every(s => s === OK)).toBe(true);
    // a gap inside the lead-in still reaches into the range
    const rec = recorder(lo, from + 5);
    rec.delete(hash(from - 2));
    const g = assembleOffMempool(chain(lo, from + 5), rec, [], H0, from);
    expect(states(g)).toEqual([G, G, G, G, G, OK]);
    // syncs before the lead-in only reach lead-in blocks
    expect(states(assembleOffMempool(chain(lo, from + 5), recorder(lo, from + 5), [seen(lo) - 1], H0, from)).every(s => s === OK)).toBe(true);
  });

  it('a coinbase-only block has no share (not 0%)', () => {
    const rows = assembleOffMempool(chain(H0, H0 + 7), recorder(H0, H0 + 7, h => (h === H0 + 7 ? { tx_count: 1, off_mempool: 0 } : {})), [], H0, H0);
    expect(rows[7].slice(2, 5)).toEqual([0, 0, OFF_STATE.coinbaseOnly]);
  });

  it('only best-chain blocks are rows: a recorder row for a reorged-out block is ignored', () => {
    const rec = recorder(H0, H0 + 7);
    rec.set('ff'.repeat(32), { hash: 'ff'.repeat(32), seen_ms: seen(H0 + 7), tx_count: 5000, off_mempool: 4999, checked: true });
    const rows = assembleOffMempool(chain(H0, H0 + 7), rec, [], H0, H0);
    expect(rows).toHaveLength(8);
    expect(rows[7][3]).toBe(1);
  });
});

describe('positions and hashes', () => {
  it('runs of consecutive positions', () => {
    expect(positionRuns([7, 1, 2, 3, 3, 9, 10])).toEqual([[1, 3], [7, 7], [9, 10]]);
    expect(positionRuns([])).toEqual([]);
    expect(formatRuns([[1, 3], [7, 7]])).toBe('1–3, 7');
    expect(formatRuns([[1, 1], [3, 3], [5, 5], [7, 7], [9, 9]])).toBe('1, 3, 5, 7 …');
  });
  it('reverses byte order', () => {
    expect(reverseHex('0011ff')).toBe('ff1100');
    expect(reverseHex(reverseHex(hash(42)))).toBe(hash(42));
  });
});
