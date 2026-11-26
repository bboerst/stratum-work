import { getPgPool } from './pg';
import { reverseHex, type ChainBlock, type RecordedBlock } from '../offMempool';

/**
 * Reads behind /api/off-mempool (#328): best-chain blocks, the mempool recorder's rows for them, its resyncs, and one
 * block's off-mempool positions. All bounded by height (or by time from the first block of the range).
 *
 * mempool_* hashes are in internal byte order, blocks' in display order: the join is done here by reversing the
 * hex (hash_from_display() per row in SQL costs ~50 µs a block).
 */

/** The first height the recorder wrote (null: no record yet). */
export async function getRecordFrom(): Promise<number | null> {
  const { rows } = await getPgPool().query<{ height: number | null }>(
    `SELECT height FROM mempool_blocks WHERE event = 'connect' AND height IS NOT NULL ORDER BY seen_at LIMIT 1`);
  return rows[0]?.height ?? null;
}

export async function getChainBlocks(from: number, to: number): Promise<ChainBlock[]> {
  const { rows } = await getPgPool().query<{ height: number; hash: string; pool: string | null; time_s: string }>(
    `SELECT height, encode(block_hash, 'hex') AS hash, mining_pool->>'name' AS pool,
            extract(epoch FROM block_time)::bigint AS time_s
       FROM blocks_best WHERE height BETWEEN $1 AND $2 ORDER BY height`, [from, to]);
  return rows.map(r => ({ height: r.height, hash: r.hash, pool: r.pool || 'Unknown', time_s: Number(r.time_s) }));
}

/** The recorder's first connect row of each block in the height range, keyed by display-order hash. */
export async function getRecordedBlocks(from: number, to: number): Promise<Map<string, RecordedBlock>> {
  const { rows } = await getPgPool().query<{ hash: string; seen_ms: string; tx_count: number; off_mempool: number | null; checked: boolean }>(
    `SELECT DISTINCT ON (block_hash) encode(block_hash, 'hex') AS hash,
            (extract(epoch FROM seen_at) * 1000)::bigint AS seen_ms, tx_count, off_mempool, off_mempool_checked AS checked
       FROM mempool_blocks WHERE event = 'connect' AND height BETWEEN $1 AND $2 ORDER BY block_hash, seen_at`, [from, to]);
  const out = new Map<string, RecordedBlock>();
  for (const r of rows) {
    const hash = reverseHex(r.hash);
    out.set(hash, { hash, seen_ms: Number(r.seen_ms), tx_count: r.tx_count, off_mempool: r.off_mempool, checked: r.checked });
  }
  return out;
}

/**
 * When the recorder resynced since `since_ms`: each sync closes the rows of transactions that left while it wasn't
 * following, all at the sync's time (removed_src 'resync'). A sync that closed nothing leaves no trace here.
 * mempool_txs is ordered by removed_at in its compressed batches, so the bound skips most of it (~1 s on production).
 */
export async function getResyncTimes(since_ms: number): Promise<number[]> {
  const { rows } = await getPgPool().query<{ ms: string }>(
    `SELECT DISTINCT (extract(epoch FROM removed_at) * 1000)::bigint AS ms
       FROM mempool_txs WHERE removed_src = 'resync' AND removed_at >= to_timestamp($1 / 1000.0)`, [since_ms]);
  return rows.map(r => Number(r.ms)).sort((a, b) => a - b);
}

/** The off-mempool positions (1 = first after the coinbase) of the best-chain block at a height. */
export async function getOffPositions(height: number): Promise<number[]> {
  const { rows } = await getPgPool().query<{ position: number }>(
    `SELECT o.position FROM blocks_best b
       JOIN mempool_offmempool o ON o.block_hash = hash_from_display(encode(b.block_hash, 'hex'))
      WHERE b.height = $1 ORDER BY o.position`, [height]);
  return rows.map(r => r.position);
}
