/**
 * The reads behind /api/template-providers (lib/templateProviders.ts derives the providers): the backend's per-height
 * counts (template_set_heights / _feeds / _pairs, backend/template_sets.py) summed per difficulty epoch, our
 * best-chain blocks from the first counted epoch, and the pool names; and for /api/forks just the epochs its episodes
 * need. Excluded names (POOL_BLACKLIST, passed as $1) are dropped here, before any grouping: a node whose feed is
 * excluded or whose paid pool's name is (exact match on pools.name; an unidentified payer is kept), and every pair
 * touching one. All SQL is parameterized.
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
  const [{ nodes, pairs }, blocks, pools] = await Promise.all([
    nodesAndPairs(excluded, from, null),
    pool.query(
      `SELECT height, pool_id, mining_pool->>'name' AS pool, nullif(mining_pool->>'datum_template_creator', '') AS creator,
              (extract(epoch FROM block_time) * 1000)::bigint AS time_ms
         FROM blocks_best WHERE height >= $1 ORDER BY height`, [from]),
    pool.query(`SELECT id, name FROM pools`),
  ]);
  return {
    counted: epochs,
    nodes, pairs,
    blocks: blocks.rows.map((r): BlockRow => ({ height: Number(r.height), pool_id: toNum(r.pool_id), pool: r.pool ?? null, creator: r.creator ?? null, time_ms: Number(r.time_ms) })),
    poolNames: new Map(pools.rows.map(r => [Number(r.id), String(r.name)])),
  };
}

/**
 * The node and pair rows summed per epoch, over heights [from, to) (to null: no upper bound; the tables' keys lead
 * with height), without the excluded names: a node whose feed is excluded, or whose paid pool is (pools.name, so
 * another feed's templates paying an excluded pool add no node named after it either), and every pair touching one.
 */
async function nodesAndPairs(excluded: string[], from: number, to: number | null): Promise<{ nodes: NodeRow[]; pairs: PairRow[] }> {
  const pool = getPgPool();
  const upTo = to ?? 2_147_483_647;
  // the excluded pools' ids (none for an empty list): a node paying one is dropped like an excluded feed's
  const xp = `(SELECT id FROM pools WHERE name = ANY ($1::text[]))`;
  const [nodes, pairs] = await Promise.all([
    pool.query(
      `SELECT height / ${EPOCH_BLOCKS} AS epoch, feed, pool_id, sum(sets) AS sets, sum(templates) AS templates
         FROM template_set_feeds
        WHERE height >= $2 AND height < $3 AND feed <> ALL ($1::text[]) AND (pool_id IS NULL OR pool_id NOT IN ${xp})
        GROUP BY 1, 2, 3`,
      [excluded, from, upTo]),
    pool.query(
      `SELECT height / ${EPOCH_BLOCKS} AS epoch, feed_a, pool_a, feed_b, pool_b, sum(shared) AS shared
         FROM template_set_pairs
        WHERE height >= $2 AND height < $3 AND feed_a <> ALL ($1::text[]) AND feed_b <> ALL ($1::text[])
          AND (pool_a IS NULL OR pool_a NOT IN ${xp}) AND (pool_b IS NULL OR pool_b NOT IN ${xp})
        GROUP BY 1, 2, 3, 4, 5`,
      [excluded, from, upTo]),
  ]);
  return {
    nodes: nodes.rows.map((r): NodeRow => ({ epoch: Number(r.epoch), feed: r.feed, pool_id: toNum(r.pool_id), sets: Number(r.sets), templates: Number(r.templates) })),
    pairs: pairs.rows.map((r): PairRow => ({ epoch: Number(r.epoch), feed_a: r.feed_a, pool_a: toNum(r.pool_a), feed_b: r.feed_b, pool_b: toNum(r.pool_b), shared: Number(r.shared) })),
  };
}

export interface EpochGroupInputs { nodes: NodeRow[]; pairs: PairRow[]; counted: { epoch: number; heights: number }[] }

/**
 * The inputs for grouping just the given epochs (Forks: the epochs its episodes fall in): their counted heights, and
 * their node and pair rows, read over the heights from the lowest to the highest of them and kept for those epochs
 * only. Excluded feeds dropped as above. An epoch with no counted heights is absent from `counted`.
 */
export async function getEpochGroupInputs(epochs: number[], excluded: string[]): Promise<EpochGroupInputs> {
  const want = [...new Set(epochs)].sort((a, b) => a - b);
  if (want.length === 0) return { nodes: [], pairs: [], counted: [] };
  const from = want[0] * EPOCH_BLOCKS, to = (want[want.length - 1] + 1) * EPOCH_BLOCKS;
  const keep = new Set(want);
  const [counted, rows] = await Promise.all([
    getPgPool().query<{ epoch: number; heights: string }>(
      `SELECT height / ${EPOCH_BLOCKS} AS epoch, count(*) AS heights FROM template_set_heights
        WHERE height >= $1 AND height < $2 GROUP BY 1 ORDER BY 1`, [from, to]),
    nodesAndPairs(excluded, from, to),
  ]);
  return {
    counted: counted.rows.map(r => ({ epoch: Number(r.epoch), heights: Number(r.heights) })).filter(c => keep.has(c.epoch)),
    nodes: rows.nodes.filter(n => keep.has(n.epoch)),
    pairs: rows.pairs.filter(p => keep.has(p.epoch)),
  };
}
