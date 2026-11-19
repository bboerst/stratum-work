/**
 * Transaction lookups from the mempool recorder's tables (#198): what our own node saw of a transaction, so the web
 * doesn't need a third-party explorer for a template's first transaction (db/migrations/20261116000001_mempool.sql).
 *
 * txids are taken and returned in DISPLAY order (RPC / explorer hex). The tables store internal byte order;
 * hash_from_display() / hash_display() convert.
 *
 * Time window: a transaction pending at time `at` (e.g. in a template received then) entered the mempool at most
 * -mempoolexpiry (14 days) before, so only stays first seen in [at - 15 days, at + 1 hour) are looked at (`at`
 * defaults to now). That bounds the search to about 16 daily chunks: a txid we never saw would otherwise be looked
 * for in every chunk ever written, and each compressed one costs a bloom-filter scan of its batches plus decompressing
 * the false positives (measured: ~9 ms per txid per 26 compressed chunks of 60k rows, growing with history). Within the
 * window, each txid walks the chunks newest first and stops at its latest stay. Off-mempool records (one indexed probe)
 * aren't time-bounded.
 *
 * Fee rates (sat/vB):
 *   fee_rate            fee / vsize: the transaction on its own.
 *   ancestor_fee_rate   ancestor_fees / ancestor_vsize as of first seen: the transaction together with its unconfirmed
 *                       ancestors (Core's ancestor package; modified fees, sigop-adjusted vsize), as getmempoolentry
 *                       reported when it entered our mempool.
 *   child_package_fee_rate  the highest ancestor-package rate among its direct children that our node had seen by
 *                       `at`: each child's ancestor_fees / ancestor_vsize as of the child's first seen, which is the
 *                       package (this transaction included) a miner selecting by ancestor package mines it in when a
 *                       child pays for it (CPFP). From mempool_tx_inputs, so only within its 30-day retention; null
 *                       without such a child. Grandchildren aren't followed.
 *   effective_fee_rate  the rate a miner selecting by ancestor package gets for it: the smaller of fee_rate and
 *                       ancestor_fee_rate when it has unconfirmed ancestors (low-fee parents pull it down; high-fee
 *                       parents are mined on their own first), else fee_rate; raised to child_package_fee_rate when a
 *                       child pays more. See web/app/api/tx/README.md.
 */
import { getPgPool } from './pg';

export const TX_BATCH_MAX = 100;
export const TX_WINDOW_BEFORE_MS = 15 * 86_400_000;
export const TX_WINDOW_AFTER_MS = 3_600_000;
export const TXID_RE = /^[0-9a-f]{64}$/;

export type TxStatus =
  | 'in_mempool' | 'mined' | 'replaced' | 'conflict' | 'reorg' | 'expired' | 'evicted' | 'unknown'
  | 'off_mempool' | 'not_seen';

export interface TxRemoval {
  at: number;                    // ms since the epoch
  reason: Exclude<TxStatus, 'in_mempool' | 'off_mempool' | 'not_seen'>;
  source: 'zmq' | 'resync';      // resync: found gone at a sync, `at` is an upper bound
  replaced_by: string | null;    // replaced: the replacement; conflict: the block transaction spending its input
  block_hash: string | null;     // mined / conflict
  block_height: number | null;
}

export interface TxOffMempool {
  block_hash: string;
  height: number | null;
  seen_at: number;               // when the block connected, ms since the epoch
  position: number;              // index in the block (1 = first after the coinbase)
}

/**
 * A direct child our node had seen spending the transaction (by `at`): the one with the highest ancestor-package rate.
 * same_block: once this transaction is mined (as our node saw it), whether the child was mined in the same block;
 * null before.
 */
export interface TxChild {
  txid: string;
  first_seen: number;            // ms since the epoch, when our node first saw the child
  package_fee_rate: number;      // the child's ancestor_fees / ancestor_vsize (this transaction included)
  block_hash: string | null;     // the block that mined the child, if our node saw it mined
  same_block: boolean | null;
}

export interface TxInfo {
  txid: string;
  found: boolean;                // false: our node never saw it (in its mempool within the time window, or in a block)
  status: TxStatus;
  fee?: number | null;           // satoshis
  vsize?: number | null;
  weight?: number | null;
  size?: number | null;
  fee_rate?: number | null;
  ancestor_fee_rate?: number | null;
  child_package_fee_rate?: number | null;
  child?: TxChild | null;        // the child behind child_package_fee_rate
  effective_fee_rate?: number | null;
  ancestor_count?: number | null;
  ancestor_vsize?: number | null;
  ancestor_fees?: number | null;
  descendant_count?: number | null;
  descendant_vsize?: number | null;
  descendant_fees?: number | null;
  first_seen?: number | null;    // ms since the epoch, of the latest stay in our mempool
  first_seen_src?: 'zmq' | 'mempool' | null;
  removal?: TxRemoval | null;    // null while still in the mempool
  offmempool?: TxOffMempool | null;
}

export interface TxRow {
  txid: string;
  m_first_seen_ms: string | number | null;
  first_seen_src: 'zmq' | 'mempool' | null;
  size: number | null;
  vsize: number | null;
  weight: number | null;
  fee: string | number | null;
  ancestor_count: number | null;
  ancestor_size: number | null;
  ancestor_fees: string | number | null;
  descendant_count: number | null;
  descendant_size: number | null;
  descendant_fees: string | number | null;
  removed_ms: string | number | null;
  removal: TxRemoval['reason'] | null;
  removed_src: 'zmq' | 'resync' | null;
  replaced_by: string | null;
  block_hash: string | null;
  block_height: number | null;
  o_block_hash: string | null;
  o_height: number | null;
  o_seen_ms: string | number | null;
  o_position: number | null;
  child_package_fee_rate: string | number | null;
  child_txid: string | null;
  child_first_seen_ms: string | number | null;
  child_block_hash: string | null;
}

const numOrNull = (v: string | number | null | undefined) => (v === null || v === undefined ? null : Number(v));

/** Fee rates in sat/vB, unrounded (the client formats them). */
export function feeRates(fee: number | null, vsize: number | null, ancestorCount: number | null,
                         ancestorFees: number | null, ancestorVsize: number | null,
                         childPackageRate: number | null = null) {
  const fee_rate = fee !== null && vsize ? fee / vsize : null;
  const ancestor_fee_rate = ancestorFees !== null && ancestorVsize ? ancestorFees / ancestorVsize : null;
  const own = (ancestorCount ?? 1) > 1 && ancestor_fee_rate !== null
    ? (fee_rate === null ? ancestor_fee_rate : Math.min(fee_rate, ancestor_fee_rate))
    : fee_rate;
  // A child paying for it (CPFP) gets it mined at the child's package rate, when that is higher.
  const effective_fee_rate = childPackageRate !== null && (own === null || childPackageRate > own) ? childPackageRate : own;
  return { fee_rate, ancestor_fee_rate, child_package_fee_rate: childPackageRate, effective_fee_rate };
}

export function rowToTxInfo(r: TxRow): TxInfo {
  const inMempoolTable = r.m_first_seen_ms !== null && r.m_first_seen_ms !== undefined;
  const offmempool: TxOffMempool | null = r.o_block_hash ? {
    block_hash: r.o_block_hash, height: r.o_height, seen_at: Number(r.o_seen_ms), position: r.o_position ?? 0,
  } : null;
  if (!inMempoolTable && !offmempool) return { txid: r.txid, found: false, status: 'not_seen' };

  const removedMs = numOrNull(r.removed_ms);
  const removal: TxRemoval | null = removedMs !== null && r.removal ? {
    at: removedMs, reason: r.removal, source: r.removed_src ?? 'zmq', replaced_by: r.replaced_by,
    block_hash: r.block_hash, block_height: r.block_height,
  } : null;
  // The latest record decides: a still-open stay is in the mempool; an off-mempool block newer than the last stay
  // (or with no stay at all) mined it without our mempool having it.
  let status: TxStatus;
  if (inMempoolTable && !removal) status = 'in_mempool';
  else if (offmempool && (!removal || offmempool.seen_at >= removal.at)) status = 'off_mempool';
  else status = removal!.reason;

  const fee = numOrNull(r.fee);
  const ancestorFees = numOrNull(r.ancestor_fees);
  return {
    txid: r.txid, found: true, status,
    fee, vsize: r.vsize, weight: r.weight, size: r.size,
    ...feeRates(fee, r.vsize, r.ancestor_count, ancestorFees, r.ancestor_size, numOrNull(r.child_package_fee_rate)),
    ancestor_count: r.ancestor_count, ancestor_vsize: r.ancestor_size, ancestor_fees: ancestorFees,
    descendant_count: r.descendant_count, descendant_vsize: r.descendant_size, descendant_fees: numOrNull(r.descendant_fees),
    child: r.child_txid && r.child_package_fee_rate !== null ? {
      txid: r.child_txid, first_seen: Number(r.child_first_seen_ms), package_fee_rate: Number(r.child_package_fee_rate),
      block_hash: r.child_block_hash,
      // Once this transaction is mined: was the child in that block? Unknown (null) before.
      same_block: removal?.reason === 'mined' && removal.block_hash ? r.child_block_hash === removal.block_hash : null,
    } : null,
    first_seen: numOrNull(r.m_first_seen_ms), first_seen_src: r.first_seen_src,
    removal, offmempool,
  };
}

const MS = (col: string) => `(extract(epoch FROM ${col}) * 1000)::bigint`;

/**
 * $1: display-order txids (text[]); $2, $3: the first_seen window; $4: `at`. One row per txid; the mempool_txs columns
 * are NULL if it has no stay in the window. MATERIALIZED: hash_from_display() runs once per txid, not once per
 * decompressed row. Children: transactions with an input spending it (mempool_tx_inputs), first seen during its stay
 * and by `at`; their mempool_txs rows give each child's ancestor package (this transaction included).
 */
export const TX_SQL = `WITH q AS MATERIALIZED (SELECT d.display, hash_from_display(d.display) AS txid FROM unnest($1::text[]) AS d (display))
  SELECT q.display AS txid,
         ${MS('m.first_seen')} AS m_first_seen_ms, m.first_seen_src, m.size, m.vsize, m.weight, m.fee,
         m.ancestor_count, m.ancestor_size, m.ancestor_fees, m.descendant_count, m.descendant_size, m.descendant_fees,
         ${MS('m.removed_at')} AS removed_ms, m.removal, m.removed_src,
         hash_display(m.replaced_by) AS replaced_by, hash_display(m.block_hash) AS block_hash, m.block_height,
         hash_display(o.block_hash) AS o_block_hash, o.height AS o_height, ${MS('o.seen_at')} AS o_seen_ms,
         o.position AS o_position, k.child_package_fee_rate, k.child_txid, k.child_first_seen_ms, k.child_block_hash
    FROM q
    LEFT JOIN LATERAL (
      SELECT * FROM mempool_txs t WHERE t.txid = q.txid AND t.first_seen >= $2::timestamptz AND t.first_seen < $3::timestamptz
       ORDER BY t.first_seen DESC LIMIT 1
    ) m ON true
    LEFT JOIN LATERAL (
      SELECT * FROM mempool_offmempool x WHERE x.txid = q.txid ORDER BY x.seen_at DESC LIMIT 1
    ) o ON true
    LEFT JOIN LATERAL (
      SELECT c.rate AS child_package_fee_rate, hash_display(ci.txid) AS child_txid,
             ${MS('ci.first_seen')} AS child_first_seen_ms, hash_display(c.block_hash) AS child_block_hash
        FROM (SELECT DISTINCT i.txid, i.first_seen FROM mempool_tx_inputs i
               WHERE i.prevout_txid = q.txid AND i.first_seen >= m.first_seen
                 AND i.first_seen >= $2::timestamptz AND i.first_seen <= $4::timestamptz) ci
        CROSS JOIN LATERAL (
          SELECT t.ancestor_fees::float8 / t.ancestor_size AS rate, t.block_hash FROM mempool_txs t
           WHERE t.txid = ci.txid AND t.first_seen = ci.first_seen
             AND t.first_seen >= $2::timestamptz AND t.first_seen <= $4::timestamptz AND t.ancestor_size > 0
           LIMIT 1   -- keeps it a per-child lookup (index / bloom filter), not a hash join over the whole window
        ) c
       ORDER BY c.rate DESC LIMIT 1
    ) k ON m.first_seen IS NOT NULL`;

/**
 * Look up display-order txids (validated, lower-case, at most TX_BATCH_MAX), one result per txid in input order, as of
 * `atMs` (ms since the epoch, default now): see the time window above.
 */
export async function getTxs(txids: string[], atMs: number = Date.now()): Promise<TxInfo[]> {
  if (txids.length === 0) return [];
  if (txids.length > TX_BATCH_MAX) throw new Error(`at most ${TX_BATCH_MAX} txids`);
  for (const t of txids) if (!TXID_RE.test(t)) throw new Error('txids must be 64 lower-case hex characters');
  const rows = (await getPgPool().query<TxRow>(TX_SQL, [txids, new Date(atMs - TX_WINDOW_BEFORE_MS),
    new Date(atMs + TX_WINDOW_AFTER_MS), new Date(atMs)])).rows;
  const byTxid = new Map(rows.map(r => [r.txid, rowToTxInfo(r)]));
  return txids.map(t => byTxid.get(t) ?? { txid: t, found: false, status: 'not_seen' });
}

/**
 * How long an answer may be reused (seconds): a transaction still in the mempool, or one we haven't seen, can change
 * soon (it leaves; it arrives late); one that has left or was mined is settled (a reorg can still change it, rarely).
 */
export function txMaxAgeS(t: TxInfo): number {
  if (t.status === 'not_seen') return 10;
  if (t.status === 'in_mempool') return 30;
  return 3600;
}
