/**
 * Off-mempool share per block (#328): how many of a block's transactions our node never had in its mempool before
 * the block connected, as the mempool recorder wrote them (mempool_blocks.off_mempool, mempool_offmempool). Pure:
 * the reads are lib/db/off-mempool.ts, the route app/api/off-mempool. The measure and its gaps are explained in
 * docs/methodology.md ("Off-mempool transactions").
 *
 * A block's count is only a measurement when the recorder was following the node for long enough before it.
 * Otherwise the block is "no data", never zero:
 *  - before the record: below the first block the recorder wrote;
 *  - missed: a best-chain block with no recorder row (the recorder, or the node, was down when it connected);
 *  - unchecked: a recorder row written while it wasn't synced (off_mempool_checked false);
 *  - after a gap: one of the AFTER_GAP_BLOCKS blocks recorded after a gap (a missed or unchecked block, a resync,
 *    or the start of the record). Transactions broadcast while our node or the recorder wasn't following are
 *    missing, so the next blocks count them as never seen: on production the counts of the 3 blocks after each gap
 *    were 18-63% for miners otherwise near 0%. 6 is about twice that;
 *  - coinbase only: a block with no other transaction has no share (0 of 0).
 */

export const AFTER_GAP_BLOCKS = 6;

/** A row's state: 0 measured; the others are no data, for the reason named. */
export const OFF_STATE = { measured: 0, missed: 1, unchecked: 2, afterGap: 3, coinbaseOnly: 4 } as const;
export type OffState = typeof OFF_STATE[keyof typeof OFF_STATE];

/** A best-chain block (display-order hash, hex). */
export interface ChainBlock {
  height: number;
  hash: string;
  pool: string;
  time_s: number;   // header time, for the date on hover
}

/** The recorder's row for a block (its first connect), keyed by display-order hash. */
export interface RecordedBlock {
  hash: string;
  seen_ms: number;
  tx_count: number;          // incl. the coinbase
  off_mempool: number | null;
  checked: boolean;
}

/** [height, pool, transactions excl. the coinbase (null: no recorder row), off-mempool (null: not measured), state, time_s] */
export type OffRow = [number, string, number | null, number | null, OffState, number];

/**
 * One row per best-chain block from `fromHeight` (or `recordFrom`, the first height the recorder wrote, if higher),
 * oldest first. Pass `blocks` from AFTER_GAP_BLOCKS below `fromHeight` (leadIn()): a gap just before the range is
 * found in them, and the range's own start isn't taken for one. `syncs_ms`: times the recorder resynced (each is a
 * gap: what it missed while not following isn't in its record). The start of the record is a gap too: the recorder
 * had only just begun following.
 */
export function assembleOffMempool(blocks: ChainBlock[], recorded: Map<string, RecordedBlock>, syncs_ms: number[],
  recordFrom: number | null, fromHeight: number): OffRow[] {
  if (recordFrom === null) return [];
  const chain = blocks.filter(b => b.height >= recordFrom).sort((a, b) => a.height - b.height);
  if (chain.length === 0) return [];
  const syncs = [...syncs_ms].sort((a, b) => a - b);
  const rows: OffRow[] = [];
  // recorded blocks since the last gap: the record's start is one; a lead-in's first block isn't (a gap before it
  // only reaches lead-in blocks)
  let sinceGap = chain[0].height === recordFrom ? 0 : AFTER_GAP_BLOCKS;
  const first = chain.map(b => recorded.get(b.hash)).find(r => r !== undefined);
  let nextSync = first ? syncs.findIndex(t => t > first.seen_ms) : syncs.length;   // earlier syncs: lead-in only
  if (nextSync < 0) nextSync = syncs.length;
  for (const b of chain) {
    const r = recorded.get(b.hash);
    if (!r) {
      rows.push([b.height, b.pool, null, null, OFF_STATE.missed, b.time_s]);
      sinceGap = 0;
      continue;
    }
    // a resync at or before this block's connect is a gap just before it
    while (nextSync < syncs.length && syncs[nextSync] <= r.seen_ms) { nextSync++; sinceGap = 0; }
    const txs = r.tx_count - 1;
    let state: OffState;
    if (!r.checked || r.off_mempool === null) { state = OFF_STATE.unchecked; sinceGap = 0; }
    else if (sinceGap < AFTER_GAP_BLOCKS) { state = OFF_STATE.afterGap; sinceGap++; }
    else state = txs <= 0 ? OFF_STATE.coinbaseOnly : OFF_STATE.measured;
    // a count is served only when it is a measurement (or 0 of 0): never the inflated count after a gap
    rows.push([b.height, b.pool, txs, state === OFF_STATE.measured || state === OFF_STATE.coinbaseOnly ? r.off_mempool : null, state, b.time_s]);
  }
  return rows.filter(r => r[0] >= fromHeight);
}

/** The lowest height to read for a range starting at fromHeight (see assembleOffMempool). */
export function leadIn(fromHeight: number, recordFrom: number): number {
  return Math.max(recordFrom, fromHeight - AFTER_GAP_BLOCKS);
}

/** Positions (1 = first after the coinbase) as runs: [1, 2, 3, 7] → [[1, 3], [7, 7]]. */
export function positionRuns(positions: number[]): [number, number][] {
  const p = [...new Set(positions)].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const x of p) {
    const last = out[out.length - 1];
    if (last && x === last[1] + 1) last[1] = x;
    else out.push([x, x]);
  }
  return out;
}

/** Runs as text, the first `max` of them: "1–3, 7 …". */
export function formatRuns(runs: [number, number][], max = 4): string {
  const s = runs.slice(0, max).map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(", ");
  return runs.length > max ? `${s} …` : s;
}

/** Display-order hex of an internal-order hash (and back: the reversal is its own inverse). */
export function reverseHex(hex: string): string {
  return (hex.match(/../g) ?? []).reverse().join("");
}
