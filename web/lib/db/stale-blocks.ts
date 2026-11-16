/**
 * Stale (orphaned) blocks the node saw, with the templates pools built on them (#180, slice 3). Postgres only: the
 * backend records stale_blocks / chain_reorgs, and stale_tip_templates() finds the templates whose prev_hash is a
 * stale block (db/migrations/20261116100001_stale_blocks.sql). MongoDB mode has no such data.
 *
 * Hashes are lower-case hex in RPC / explorer byte order (like blocks). Templates built on a stale block at height h
 * are at height h + 1; each block's template summary is one stale_tip_templates(h + 1, h + 1) call, so the read stays
 * on one height of the templates index per block, however far apart the stale blocks are.
 */
import { getPgPool } from './pg';

export const STALE_BLOCKS_MAX = 100;

export interface StaleBlockRow {
  block_hash: string;
  height: number;
  prev_hash: string;
  block_time_s: string | number;
  first_seen_ms: string | number;
  chaintip_status: string;
  last_status: string;
  full_block: boolean;
  was_active: boolean;
  reorged_in_ms: string | number | null;
  tx_count: number | null;
  size: number | null;
  weight: number | null;
  coinbase_script_sig: string | null;
  mining_pool: Record<string, unknown> | null;
  reorg_id: string | number | null;
  reorg_detected_ms: string | number | null;
  reorg_depth: number | null;
  reorg_fork_height: number | null;
  reorg_new_tip_hash: string | null;
}

export interface StaleTemplateRow {
  stale_block_hash: string;
  height: number;
  pool: string;
  templates: string | number;
  first_ms: string | number;
  last_ms: string | number;
  switch_ms: string | number | null;
}

export interface StaleTemplateSummary {
  pool: string;
  height: number;
  templates: number;
  first_template_at: number;       // ms since the epoch
  last_template_at: number;
  node_switch_at: number | null;   // when our node moved past this block (reorg detection, or the winner's arrival)
  mined_after_switch_ms: number | null;   // last_template_at - node_switch_at (negative: moved on before our node)
}

export interface StaleBlock {
  block_hash: string;
  height: number;
  prev_hash: string;
  timestamp: number;               // header time, unix seconds
  first_seen: number;              // ms since the epoch: first seen as a non-active block
  chaintip_status: string;
  last_status: string;
  full_block: boolean;
  was_active: boolean;
  reorged_in_at: number | null;
  tx_count: number | null;
  size: number | null;
  weight: number | null;
  coinbase_script_sig: string | null;
  mining_pool: Record<string, unknown> | null;
  reorg: { id: number; detected_at: number; depth: number; fork_height: number; new_tip_hash: string } | null;
  templates: StaleTemplateSummary[];
}

const num = (v: string | number) => Number(v);
const numOrNull = (v: string | number | null) => (v === null || v === undefined ? null : Number(v));

export function templateRowToSummary(r: StaleTemplateRow): StaleTemplateSummary {
  const sw = numOrNull(r.switch_ms);
  return {
    pool: r.pool, height: r.height, templates: num(r.templates),
    first_template_at: num(r.first_ms), last_template_at: num(r.last_ms),
    node_switch_at: sw, mined_after_switch_ms: sw === null ? null : num(r.last_ms) - sw,
  };
}

export function staleRowToBlock(r: StaleBlockRow, templates: StaleTemplateSummary[]): StaleBlock {
  return {
    block_hash: r.block_hash, height: r.height, prev_hash: r.prev_hash, timestamp: num(r.block_time_s),
    first_seen: num(r.first_seen_ms), chaintip_status: r.chaintip_status, last_status: r.last_status,
    full_block: r.full_block, was_active: r.was_active, reorged_in_at: numOrNull(r.reorged_in_ms),
    tx_count: r.tx_count, size: r.size, weight: r.weight, coinbase_script_sig: r.coinbase_script_sig,
    mining_pool: r.mining_pool,
    reorg: r.reorg_id === null || r.reorg_id === undefined ? null : {
      id: num(r.reorg_id), detected_at: num(r.reorg_detected_ms ?? 0), depth: r.reorg_depth ?? 0,
      fork_height: r.reorg_fork_height ?? 0, new_tip_hash: r.reorg_new_tip_hash ?? '',
    },
    templates,
  };
}

const MS = (col: string) => `(extract(epoch FROM ${col}) * 1000)::bigint`;

/** The n most recent stale blocks (by height), each with the per-pool summary of templates built on it. */
export async function getRecentStaleBlocks(n: number): Promise<StaleBlock[]> {
  const limit = Math.min(Math.max(1, Math.floor(Number.isFinite(n) ? n : 20)), STALE_BLOCKS_MAX);
  const pool = getPgPool();
  const blocks = (await pool.query<StaleBlockRow>(
    `SELECT encode(s.block_hash, 'hex') AS block_hash, s.height, encode(s.prev_hash, 'hex') AS prev_hash,
            extract(epoch FROM s.block_time)::bigint AS block_time_s, ${MS('s.first_seen')} AS first_seen_ms,
            s.chaintip_status, s.last_status, s.full_block, s.was_active, ${MS('s.reorged_in_at')} AS reorged_in_ms,
            s.tx_count, s.size, s.weight, encode(s.coinbase_script_sig, 'hex') AS coinbase_script_sig, s.mining_pool,
            r.id AS reorg_id, ${MS('r.detected_at')} AS reorg_detected_ms, r.depth AS reorg_depth,
            r.fork_height AS reorg_fork_height, encode(r.new_tip_hash, 'hex') AS reorg_new_tip_hash
       FROM stale_blocks s LEFT JOIN chain_reorgs r ON r.id = s.reorg_id
      ORDER BY s.height DESC, s.first_seen DESC
      LIMIT ${limit}`,
  )).rows;
  if (blocks.length === 0) return [];
  const heights = [...new Set(blocks.map(b => b.height + 1))];
  const templates = (await pool.query<StaleTemplateRow>(
    `SELECT encode(t.stale_block_hash, 'hex') AS stale_block_hash, t.height, t.pool, t.templates,
            ${MS('t.first_template_at')} AS first_ms, ${MS('t.last_template_at')} AS last_ms,
            ${MS('t.node_switch_at')} AS switch_ms
       FROM unnest($1::int[]) h (height), LATERAL stale_tip_templates(h.height, h.height) t
      WHERE t.tip = 'stale'
      ORDER BY t.height DESC, t.first_template_at, t.pool`,
    [heights],
  )).rows;
  const byBlock = new Map<string, StaleTemplateSummary[]>();
  for (const t of templates) {
    const list = byBlock.get(t.stale_block_hash) ?? [];
    list.push(templateRowToSummary(t));
    byBlock.set(t.stale_block_hash, list);
  }
  return blocks.map(b => staleRowToBlock(b, byBlock.get(b.block_hash) ?? []));
}
