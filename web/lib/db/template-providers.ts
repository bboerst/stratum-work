/**
 * The reads behind /api/template-providers (lib/templateProviders.ts derives the providers): the backend's per-height
 * counts (template_set_heights / _feeds / _pairs, backend/template_sets.py) summed per difficulty epoch, our
 * best-chain blocks from the first counted epoch, and the pool names. Excluded feeds (POOL_BLACKLIST, passed as $1)
 * are dropped here, before any grouping: their nodes and every pair touching them, so the result is the one a
 * database without those feeds would give. All SQL is parameterized.
 */
import { getPgPool } from './pg';
import { EPOCH_BLOCKS, type BlockRow, type NodeRow, type PairRow, type ProviderInputs } from '../templateProviders';

const toNum = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function getTemplateProviderInputs(excluded: string[]): Promise<Omit<ProviderInputs, 'ownCreatorPrefixes'>> {
  const pool = getPgPool();
  const counted = await pool.query<{ epoch: number; heights: string }>(
    `SELECT height / ${EPOCH_BLOCKS} AS epoch, count(*) AS heights FROM template_set_heights GROUP BY 1 ORDER BY 1`);
  const epochs = counted.rows.map(r => ({ epoch: Number(r.epoch), heights: Number(r.heights) }));
  if (epochs.length === 0) return { nodes: [], pairs: [], counted: [], blocks: [], poolNames: new Map() };
  const from = epochs[0].epoch * EPOCH_BLOCKS;
  const [nodes, pairs, blocks, pools] = await Promise.all([
    pool.query(
      `SELECT height / ${EPOCH_BLOCKS} AS epoch, feed, pool_id, sum(sets) AS sets, sum(templates) AS templates
         FROM template_set_feeds WHERE feed <> ALL ($1::text[]) GROUP BY 1, 2, 3`, [excluded]),
    pool.query(
      `SELECT height / ${EPOCH_BLOCKS} AS epoch, feed_a, pool_a, feed_b, pool_b, sum(shared) AS shared
         FROM template_set_pairs WHERE feed_a <> ALL ($1::text[]) AND feed_b <> ALL ($1::text[]) GROUP BY 1, 2, 3, 4, 5`,
      [excluded]),
    pool.query(
      `SELECT height, pool_id, mining_pool->>'name' AS pool, nullif(mining_pool->>'datum_template_creator', '') AS creator,
              (extract(epoch FROM block_time) * 1000)::bigint AS time_ms
         FROM blocks_best WHERE height >= $1 ORDER BY height`, [from]),
    pool.query(`SELECT id, name FROM pools`),
  ]);
  return {
    counted: epochs,
    nodes: nodes.rows.map((r): NodeRow => ({ epoch: Number(r.epoch), feed: r.feed, pool_id: toNum(r.pool_id), sets: Number(r.sets), templates: Number(r.templates) })),
    pairs: pairs.rows.map((r): PairRow => ({ epoch: Number(r.epoch), feed_a: r.feed_a, pool_a: toNum(r.pool_a), feed_b: r.feed_b, pool_b: toNum(r.pool_b), shared: Number(r.shared) })),
    blocks: blocks.rows.map((r): BlockRow => ({ height: Number(r.height), pool_id: toNum(r.pool_id), pool: r.pool ?? null, creator: r.creator ?? null, time_ms: Number(r.time_ms) })),
    poolNames: new Map(pools.rows.map(r => [Number(r.id), String(r.name)])),
  };
}
