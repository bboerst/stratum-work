/**
 * Postgres rows → the JSON shapes the API has always returned from MongoDB (#113). Pure functions, unit-tested in
 * lib/__tests__/pgMapping.test.ts. Schema: db/migrations (templates/templates_other store hex as bytea and hex u32s
 * as bigint; re-encoding as lower-case hex gives back exactly what the pool sent, see the design doc section 3).
 *
 * IDs (Postgres has no MongoDB `_id`):
 *  - template `id` = `<source_id>-<received_at in µs since the epoch>-<job_id>`. That's the de-duplication key of
 *    `templates` (design doc section 2), so it's unique and stable for a given database. It isn't the MongoDB UUID.
 *  - block `id` = the block hash (the primary key of `blocks`).
 *  - pool `id` = the mempool/mining-pools id, as a string (MongoDB returned its ObjectId, which changed on every
 *    daily pool refresh).
 */
import type { MiningNotify } from '@prisma/client';
import { formatMiningPool, type MiningPool } from './mining-pool';

// node-postgres returns bytea as Buffer, bigint as a string, real as a number.
export interface TemplateRow {
  source_id: number;
  source_name: string;
  received_us: string;            // (extract(epoch FROM received_at) * 1e6)::bigint
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
  latency_ms?: number | null;
  latency_method?: string | null;
  chain?: string | null;          // templates_other only (R2); null for Bitcoin templates
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
 * Receive time in µs → the collector's MongoDB `timestamp`: nanoseconds since the epoch as unpadded lower-case hex.
 * Postgres keeps µs, so the last three decimal digits of the nanoseconds are zero.
 */
export function timestampHexFromMicros(us: string | number | bigint): string {
  return (BigInt(us) * BigInt(1000)).toString(16);
}

export function templateId(row: Pick<TemplateRow, 'source_id' | 'received_us' | 'job_id'>): string {
  return `${row.source_id}-${row.received_us}-${row.job_id}`;
}

/** A templates / templates_other row → the MiningNotify shape (same keys and order as Prisma's MongoDB model). */
export function templateRowToMiningNotify(row: TemplateRow): MiningNotify {
  return {
    id: templateId(row),
    height: row.height,
    pool_name: row.source_name,
    chain_family: row.chain ?? null,
    coinbase1: hex(row.coinbase1),
    coinbase2: hex(row.coinbase2),
    merkle_branches: splitBranches(row.merkle_branches),
    version: u32Hex(row.version),
    prev_hash: hex(row.prev_hash),
    timestamp: timestampHexFromMicros(row.received_us),
    nbits: u32Hex(row.nbits),
    ntime: u32Hex(row.ntime),
    clean_jobs: row.clean_jobs,
    extranonce1: hex(row.extranonce1),
    extranonce2_length: row.extranonce2_length,
    lat_ms: row.latency_ms ?? null,
    lat_m: row.latency_method ?? null,
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
}

/**
 * A blocks row → the block object the MongoDB reader returns (same keys; MongoDB's `_id` has no equivalent).
 * The optional header columns (tx_count, size, …) are only emitted when set, as in MongoDB, where the backend never
 * writes them today.
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
  return block;
}

/** R3 item: raw (unformatted) mining_pool, as the MongoDB projection returns it. */
export function blockRowToInterestingItem(row: Pick<BlockRow, 'block_hash' | 'height' | 'analysis' | 'mining_pool'>) {
  const item: { block_hash: string; analysis?: Record<string, unknown>; height: number; mining_pool?: Record<string, unknown> } = {
    block_hash: hex(row.block_hash),
    analysis: row.analysis ?? undefined,
    height: row.height,
  };
  if (row.mining_pool && !isEmptyObject(row.mining_pool)) item.mining_pool = row.mining_pool;
  return item;
}

/** R7: the Prisma Pool model's shape ({id, name, tag, addresses}). */
export function poolRowToPool(row: PoolRow) {
  return { id: String(row.id), name: row.name, tag: row.tag ?? null, addresses: row.addresses ?? [] };
}

/** R4: same keys and order as the MongoDB aggregation's $project. */
export function firstSeenRowToItem(row: FirstSeenRow) {
  return {
    firstSeenTimestamp: timestampHexFromMicros(row.received_us),
    firstSeenLatencyMs: row.latency_ms ?? null,
    poolName: row.pool_name,
  };
}
