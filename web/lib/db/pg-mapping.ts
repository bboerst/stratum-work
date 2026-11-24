/**
 * Postgres rows → the JSON shapes the API returns (#113). Pure functions,
 * unit-tested in lib/__tests__/pgMapping.test.ts. Schema: db/migrations (templates store hex as bytea and hex u32s
 * as bigint; re-encoding as lower-case hex gives back exactly what the pool sent, see the design doc section 3).
 *
 * IDs:
 *  - template `id` = `<source_id>-<received_at in µs since the epoch>-<job_id>`. That's the de-duplication key of
 *    `templates` (design doc section 2), so it's unique and stable for a given database.
 *  - block `id` = the block hash (the primary key of `blocks`).
 *  - pool `id` = the mempool/mining-pools id, as a string.
 */
import { formatMiningPool, type MiningPool } from './mining-pool';

/** A template as the API returns it: stratum's hex strings, `timestamp` = receive time as hex nanoseconds. */
export interface MiningNotify {
  id: string;
  height: number;
  pool_name: string | null;
  coinbase1: string;
  coinbase2: string;
  merkle_branches: string[];
  version: string;
  prev_hash: string;
  timestamp: string;
  /** The row's own receive time (its connection's), same format; differs from `timestamp` when that is first seen. */
  received_timestamp: string;
  nbits: string;
  ntime: string;
  clean_jobs: boolean;
  extranonce1: string;
  extranonce2_length: number;
  lat_ms: number | null;
  lat_m: string | null;
}

// node-postgres returns bytea as Buffer, bigint as a string, real as a number.
export interface TemplateRow {
  source_id: number;
  source_name: string;
  received_us: string;            // (extract(epoch FROM received_at) * 1e6)::bigint: this row's own receive time
  first_seen_us?: string;         // templates_dedup: first seen over the row and its copies from other replicas
  height: number;
  job_id: string;
  prev_hash: Buffer;
  coinbase1: Buffer;
  coinbase2: Buffer;
  merkle_branches: Buffer;
  version: string | number;
  nbits: string | number;
  ntime: string | number;
  clean_jobs: boolean;
  extranonce1: Buffer;
  extranonce2_length: number;
  latency_ms?: number | null;     // this row's own connection's estimate
  latency_method?: string | null;
  first_seen_latency_ms?: number | null;    // templates_dedup: the estimate of the copy that set first_seen
  first_seen_latency_method?: string | null;
}

export interface BlockRow {
  block_hash: Buffer;
  height: number;
  block_time_s: string | number;  // extract(epoch FROM block_time)::bigint
  coinbase_script_sig: Buffer;
  mining_pool: Record<string, unknown> | null;
  analysis: Record<string, unknown> | null;
  tx_count: number | null;
  size: number | null;
  weight: number | null;
  version: string | number | null;
  merkle_root: Buffer | null;
  bits: string | number | null;
  nonce: string | number | null;
  difficulty: number | null;
  stale?: boolean;                // only the lookup by hash selects it (recorded as stale, not active again; #194)
}

export interface PoolRow {
  id: number;
  name: string;
  tag: string | null;             // definition->>'tag'
  addresses: string[];
}

export interface FirstSeenRow {
  pool_name: string;
  received_us: string;
  latency_ms: number | null;
}

/** Lower-case hex, as the pools send it. */
export function hex(buf: Buffer): string {
  return buf.toString('hex');
}

/** A u32 stored as bigint → the 8-hex-digit string stratum uses (version, nbits, ntime). */
export function u32Hex(value: string | number): string {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`not a u32: ${value}`);
  return n.toString(16).padStart(8, '0');
}

/** Concatenated 32-byte merkle branches → list of 64-char hex strings, in stratum order. */
export function splitBranches(buf: Buffer): string[] {
  if (buf.length % 32 !== 0) throw new Error(`merkle_branches length ${buf.length} isn't a multiple of 32`);
  const out: string[] = [];
  for (let i = 0; i < buf.length; i += 32) out.push(buf.subarray(i, i + 32).toString('hex'));
  return out;
}

/**
 * Receive time in µs → the template `timestamp` (as in the live stream): nanoseconds since the epoch as unpadded
 * lower-case hex. Postgres keeps µs, so the last three decimal digits of the nanoseconds are zero.
 */
export function timestampHexFromMicros(us: string | number | bigint): string {
  return (BigInt(us) * BigInt(1000)).toString(16);
}

export function templateId(row: Pick<TemplateRow, 'source_id' | 'received_us' | 'job_id'>): string {
  return `${row.source_id}-${row.received_us}-${row.job_id}`;
}

/**
 * A templates row → the MiningNotify shape.
 * `timestamp` is the first-seen time when the read provides one (templates_dedup: a secondary replica's copy may have
 * arrived earlier); `id` always uses the row's own receive time, so it stays the table's de-duplication key.
 * `lat_ms` / `lat_m` always belong to the connection whose receive time is `timestamp`: with a first-seen time, the
 * first copy's estimate (null if it had none, never another connection's), so the latency-adjusted time doesn't mix
 * one connection's arrival with another's RTT/2.
 */
export function templateRowToMiningNotify(row: TemplateRow): MiningNotify {
  const firstSeen = row.first_seen_us != null;
  return {
    id: templateId(row),
    height: row.height,
    pool_name: row.source_name,
    coinbase1: hex(row.coinbase1),
    coinbase2: hex(row.coinbase2),
    merkle_branches: splitBranches(row.merkle_branches),
    version: u32Hex(row.version),
    prev_hash: hex(row.prev_hash),
    timestamp: timestampHexFromMicros(row.first_seen_us ?? row.received_us),
    received_timestamp: timestampHexFromMicros(row.received_us),
    nbits: u32Hex(row.nbits),
    ntime: u32Hex(row.ntime),
    clean_jobs: row.clean_jobs,
    extranonce1: hex(row.extranonce1),
    extranonce2_length: row.extranonce2_length,
    lat_ms: (firstSeen ? row.first_seen_latency_ms : row.latency_ms) ?? null,
    lat_m: (firstSeen ? row.first_seen_latency_method : row.latency_method) ?? null,
  };
}

function isEmptyObject(v: unknown): boolean {
  return !!v && typeof v === 'object' && Object.keys(v as object).length === 0;
}

export interface PgBlock {
  block_hash: string;
  analysis?: Record<string, unknown>;
  coinbase_script_sig: string;
  height: number;
  mining_pool?: MiningPool;
  timestamp: number;
  transactions?: number;
  size?: number;
  weight?: number;
  version?: number;
  merkle_root?: string;
  bits?: string;
  nonce?: number;
  difficulty?: number;
  id: string;
  stale?: true;                   // lookup by hash only: a block a reorg disconnected (absent otherwise)
  stale_siblings?: StaleSibling[]; // R5 only: other (stale) blocks recorded at this height
}

/** A stale side block at the same height as a best block (stale_blocks; pool is null when unidentified). */
export interface StaleSibling {
  block_hash: string;
  pool: string | null;
}

/**
 * A blocks row → the block object the API returns. The optional header columns (tx_count, size, …) are only emitted
 * when set (blocks stored before the backend recorded them may lack them).
 */
export function blockRowToBlock(row: BlockRow): PgBlock {
  const block: PgBlock = {
    block_hash: hex(row.block_hash),
    analysis: row.analysis ?? undefined,
    coinbase_script_sig: hex(row.coinbase_script_sig),
    height: row.height,
    // The backend stores a missing pool as {}; formatMiningPool would warn about it on every read.
    mining_pool: row.mining_pool && !isEmptyObject(row.mining_pool) ? formatMiningPool(row.mining_pool) : undefined,
    timestamp: Number(row.block_time_s),
    id: '',
  };
  if (row.tx_count != null) block.transactions = row.tx_count;
  if (row.size != null) block.size = row.size;
  if (row.weight != null) block.weight = row.weight;
  if (row.version != null) block.version = Number(row.version);
  if (row.merkle_root != null) block.merkle_root = hex(row.merkle_root);
  if (row.bits != null) block.bits = u32Hex(row.bits);
  if (row.nonce != null) block.nonce = Number(row.nonce);
  if (row.difficulty != null) block.difficulty = row.difficulty;
  block.id = block.block_hash;
  if (row.stale === true) block.stale = true;
  return block;
}

/** R3 item: raw (unformatted) mining_pool. */
export function blockRowToInterestingItem(row: Pick<BlockRow, 'block_hash' | 'height' | 'analysis' | 'mining_pool'>) {
  const item: { block_hash: string; analysis?: Record<string, unknown>; height: number; mining_pool?: Record<string, unknown> } = {
    block_hash: hex(row.block_hash),
    analysis: row.analysis ?? undefined,
    height: row.height,
  };
  if (row.mining_pool && !isEmptyObject(row.mining_pool)) item.mining_pool = row.mining_pool;
  return item;
}

/** R7: a pool as the API returns it ({id, name, tag, addresses}). */
export function poolRowToPool(row: PoolRow) {
  return { id: String(row.id), name: row.name, tag: row.tag ?? null, addresses: row.addresses ?? [] };
}

/** R4: one pool's first-seen item. */
export function firstSeenRowToItem(row: FirstSeenRow) {
  return {
    firstSeenTimestamp: timestampHexFromMicros(row.received_us),
    firstSeenLatencyMs: row.latency_ms ?? null,
    poolName: row.pool_name,
  };
}
