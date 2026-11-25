/**
 * Which stored templates a block was built from (#235): block_template_matches() (db/migrations, judged at read time
 * from the block's stored merkle branches and coinbase), the blocks at the height, and the latency estimate of each
 * match's first copy. No job ids and no template bytes are read: only who, which connection, when, and how closely.
 */
import { getPgPool } from './pg';

export interface MatchBlockSql {
  block_hash: string;            // display order
  pool: string | null;           // the block's own identification (mining_pool.name)
  seen_ms: string | null;        // when the block reached our node (seen_at), ms since the epoch
  branches: number | null;       // the block's coinbase merkle path length; null: not stored (unknown)
  coinbase_known: boolean;       // its coinbase bytes are stored (the coinbase checks can run)
}

export interface MatchRowSql {
  block_hash: string;            // display order
  pool: string;
  conn: number;                  // the pool's connection rank by (site, replica): 1 = a, 2 = b (connectionLabel)
  source_id: number;
  first_us: string;              // the first template with this transaction set on this connection, µs since the epoch
  n_rows: string;
  branches: number;
  match_depth: number;
  full_match: boolean;
  coinbase_prefix: boolean | null;
  coinbase_suffix: boolean | null;
  coinbase_layout: boolean | null;
}

export interface FirstLatencySql { source_id: number; at_us: string; latency_ms: number | null; latency_method: string | null }

export async function getMatchBlocks(height: number): Promise<MatchBlockSql[]> {
  const { rows } = await getPgPool().query<MatchBlockSql>(
    `SELECT encode(b.block_hash, 'hex') AS block_hash, b.mining_pool->>'name' AS pool,
            (extract(epoch FROM b.seen_at) * 1000)::bigint::text AS seen_ms,
            (length(b.merkle_branches) / 32)::int AS branches, b.coinbase_tx IS NOT NULL AS coinbase_known
       FROM blocks_best b WHERE b.height = $1 ORDER BY b.block_hash`, [height]);
  return rows;
}

export async function getMatchRows(height: number): Promise<MatchRowSql[]> {
  const { rows } = await getPgPool().query<MatchRowSql>(
    `SELECT encode(b.block_hash, 'hex') AS block_hash, m.pool, r.conn, m.source_id::int AS source_id,
            (extract(epoch FROM m.first_received) * 1000000)::bigint::text AS first_us, m.n_rows::text AS n_rows,
            m.branches, m.match_depth, m.full_match, m.coinbase_prefix, m.coinbase_suffix, m.coinbase_layout
       FROM block_template_matches($1, $1) m
       -- the block as stored: block_template_matches gave its hash byte-reversed before 20261125000001, so either order
       JOIN blocks_best b ON b.height = m.height
                         AND m.block_hash IN (encode(b.block_hash, 'hex'), hash_display(b.block_hash))
       JOIN (SELECT id, dense_rank() OVER (PARTITION BY name ORDER BY site COLLATE "C", replica COLLATE "C")::int AS conn
               FROM sources) r ON r.id = m.source_id
      ORDER BY m.full_match DESC, m.match_depth DESC, m.first_received`, [height]);
  return rows;
}

/**
 * The latency estimate of each given first copy (source, receive time), read from that very row, so a first-seen time
 * is only ever adjusted with its own connection's estimate (as templates_dedup's first_seen_latency_ms). Bounded by the
 * height and the exact receive times.
 */
export async function getFirstLatencies(height: number, firsts: { source_id: number; first_us: string }[]): Promise<FirstLatencySql[]> {
  if (firsts.length === 0) return [];
  const { rows } = await getPgPool().query<FirstLatencySql>(
    `SELECT DISTINCT ON (t.source_id, t.received_at) t.source_id::int AS source_id,
            (extract(epoch FROM t.received_at) * 1000000)::bigint::text AS at_us, t.latency_ms, t.latency_method::text
       FROM templates t
       JOIN unnest($2::int[], $3::bigint[]) AS f(source_id, us)
         ON t.source_id = f.source_id AND (extract(epoch FROM t.received_at) * 1000000)::bigint = f.us
      WHERE t.height = $1 AND t.received_at >= to_timestamp($4 / 1000000.0) AND t.received_at <= to_timestamp($5 / 1000000.0)
      ORDER BY t.source_id, t.received_at, t.latency_ms NULLS LAST`,
    [height, firsts.map(f => f.source_id), firsts.map(f => f.first_us),
     Math.min(...firsts.map(f => Number(f.first_us))) - 1000, Math.max(...firsts.map(f => Number(f.first_us))) + 1000]);
  return rows;
}
