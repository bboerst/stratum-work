/**
 * The reads behind /api/template-providers (lib/templateProviders.ts derives the providers): the backend's per-height
 * counts (template_set_heights / _feeds / _pairs, backend/template_sets.py) summed per difficulty epoch, our
 * best-chain blocks from the first counted epoch, and the pool names; and for /api/forks just the epochs its episodes
 * need. Both take the counts from one cached per-epoch read (readEpochRows, below). Excluded names (POOL_BLACKLIST,
 * passed as $1) are dropped here, before any grouping: a node whose feed is excluded or whose paid pool's name is
 * (exact match on pools.name; an unidentified payer is kept), and every pair touching one. All SQL is parameterized.
 */
import { getPgPool } from './pg';
import { EPOCH_BLOCKS, type BlockRow, type NodeRow, type PairRow, type ProviderInputs } from '../templateProviders';

const toNum = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function getTemplateProviderInputs(excluded: string[]): Promise<Omit<ProviderInputs, 'ownCreatorPrefixes'>> {
  const epochs = await readEpochRows(excluded);
  const { nodes, pairs, counted } = assemble(epochs, [...epochs.keys()]);
  if (counted.length === 0) return { nodes: [], pairs: [], counted: [], blocks: [], poolNames: new Map() };
  const from = counted[0].epoch * EPOCH_BLOCKS;
  const pool = getPgPool();
  const [blocks, pools] = await Promise.all([
    pool.query(
      `SELECT height, pool_id, mining_pool->>'name' AS pool, nullif(mining_pool->>'datum_template_creator', '') AS creator,
              (extract(epoch FROM block_time) * 1000)::bigint AS time_ms
         FROM blocks_best WHERE height >= $1 ORDER BY height`, [from]),
    pool.query(`SELECT id, name FROM pools`),
  ]);
  return {
    counted,
    nodes, pairs,
    blocks: blocks.rows.map((r): BlockRow => ({ height: Number(r.height), pool_id: toNum(r.pool_id), pool: r.pool ?? null, creator: r.creator ?? null, time_ms: Number(r.time_ms) })),
    poolNames: new Map(pools.rows.map(r => [Number(r.id), String(r.name)])),
  };
}

/**
 * The node and pair rows summed per epoch, over heights [from, to) (the tables' keys lead with height), without the
 * excluded names: a node whose feed is excluded, or whose paid pool is (pools.name, so another feed's templates paying
 * an excluded pool add no node named after it either), and every pair touching one.
 */
async function nodesAndPairs(excluded: string[], from: number, to: number): Promise<{ nodes: NodeRow[]; pairs: PairRow[] }> {
  const pool = getPgPool();
  // the excluded pools' ids (none for an empty list): a node paying one is dropped like an excluded feed's
  const xp = `(SELECT id FROM pools WHERE name = ANY ($1::text[]))`;
  const [nodes, pairs] = await Promise.all([
    pool.query(
      `SELECT height / ${EPOCH_BLOCKS} AS epoch, feed, pool_id, sum(sets) AS sets, sum(templates) AS templates
         FROM template_set_feeds
        WHERE height >= $2 AND height < $3 AND feed <> ALL ($1::text[]) AND (pool_id IS NULL OR pool_id NOT IN ${xp})
        GROUP BY 1, 2, 3`,
      [excluded, from, to]),
    pool.query(
      `SELECT height / ${EPOCH_BLOCKS} AS epoch, feed_a, pool_a, feed_b, pool_b, sum(shared) AS shared
         FROM template_set_pairs
        WHERE height >= $2 AND height < $3 AND feed_a <> ALL ($1::text[]) AND feed_b <> ALL ($1::text[])
          AND (pool_a IS NULL OR pool_a NOT IN ${xp}) AND (pool_b IS NULL OR pool_b NOT IN ${xp})
        GROUP BY 1, 2, 3, 4, 5`,
      [excluded, from, to]),
  ]);
  return {
    nodes: nodes.rows.map((r): NodeRow => ({ epoch: Number(r.epoch), feed: r.feed, pool_id: toNum(r.pool_id), sets: Number(r.sets), templates: Number(r.templates) })),
    pairs: pairs.rows.map((r): PairRow => ({ epoch: Number(r.epoch), feed_a: r.feed_a, pool_a: toNum(r.pool_a), feed_b: r.feed_b, pool_b: toNum(r.pool_b), shared: Number(r.shared) })),
  };
}

export interface EpochGroupInputs { nodes: NodeRow[]; pairs: PairRow[]; counted: { epoch: number; heights: number }[] }

/**
 * The inputs for grouping just the given epochs (Forks: the epochs its episodes fall in): their counted heights and
 * their node and pair rows, excluded names dropped as above. An epoch with no counted heights is absent from `counted`.
 */
export async function getEpochGroupInputs(epochs: number[], excluded: string[]): Promise<EpochGroupInputs> {
  if (epochs.length === 0) return { nodes: [], pairs: [], counted: [] };
  return assemble(await readEpochRows(excluded), epochs);
}

// --- the shared per-epoch read --------------------------------------------------------------------------------------
// /api/template-providers and Forks group the same node and pair rows, and all history of them is millions of rows to
// sum. So they're read once per process and kept per epoch, each with a fingerprint: its counted heights and the latest
// filled_at among them. The backend recomputes a height whole (delete + insert, filled_at = now()), so any change to an
// epoch's rows (a new height, the history walk or a late fill reaching an older epoch, a re-count) changes its
// fingerprint. Every read checks the fingerprints (one small query) and re-reads only the epochs whose fingerprint
// changed or that are new: after the first read, usually just the current one. The callers keep their own 5-minute
// caches and refresh in the background, so this runs about once per 5 minutes per caller.
//
// The rows are filtered by the excluded names when read, so there is one cache per list of names (the template providers
// page passes POOL_BLACKLIST; Forks passes none, its excluded pools being history there). Each is scoped by its names
// and the ids of the pools they name: if the ids differ (a pool renamed to or from an excluded name), every epoch is
// read again, so the filtering is exactly that of a fresh read.

export interface EpochRows { fingerprint: string; heights: number; nodes: NodeRow[]; pairs: PairRow[] }
interface EpochCache {
  scope: string | null;                              // the exclusion the rows were read with (names and pool ids)
  names: string | null;                              // its names alone: a failed refresh may serve the rows for them
  epochs: Map<number, EpochRows>;
  inflight: { names: string; promise: Promise<Map<number, EpochRows>> } | null;
}
// On globalThis: Next.js bundles each route separately, each with its own copy of this module, and one read per process
// is the point. Tests delete it to start cold.
const store = globalThis as { __templateSetEpochs?: Map<string, EpochCache> };
function cache(names: string): EpochCache {
  const all = (store.__templateSetEpochs ??= new Map());
  let c = all.get(names);
  if (!c) all.set(names, (c = { scope: null, names: null, epochs: new Map(), inflight: null }));
  return c;
}

/**
 * Each counted epoch's rows, excluded names dropped (see above). Concurrent callers share one refresh. A failed
 * refresh serves the last good rows for the same names (logged; the next read tries again), or throws without any.
 */
export function readEpochRows(excluded: string[]): Promise<Map<number, EpochRows>> {
  const names = JSON.stringify(excluded);
  const c = cache(names);
  if (c.inflight?.names === names) return c.inflight.promise;
  const promise = refreshEpochRows(c, excluded).finally(() => { if (c.inflight?.promise === promise) c.inflight = null; });
  c.inflight = { names, promise };
  return promise;
}

async function refreshEpochRows(c: EpochCache, excluded: string[]): Promise<Map<number, EpochRows>> {
  const names = JSON.stringify(excluded);
  try {
    const started = Date.now();
    const pool = getPgPool();
    // the fingerprints before the rows: a height filled in between is then in the rows read now and re-read next time
    const [fp, ids] = await Promise.all([
      pool.query<{ epoch: number; heights: string; filled: string }>(
        `SELECT height / ${EPOCH_BLOCKS} AS epoch, count(*) AS heights, max(filled_at)::text AS filled
           FROM template_set_heights GROUP BY 1 ORDER BY 1`),
      pool.query<{ id: number }>(`SELECT id FROM pools WHERE name = ANY ($1::text[]) ORDER BY id`, [excluded]),
    ]);
    const scope = JSON.stringify([excluded, ids.rows.map(r => Number(r.id))]);
    const prev = c.scope === scope ? c.epochs : new Map<number, EpochRows>();
    const counted = fp.rows.map(r => ({ epoch: Number(r.epoch), heights: Number(r.heights), fingerprint: `${r.heights}@${r.filled}` }));
    const changed = counted.filter(e => prev.get(e.epoch)?.fingerprint !== e.fingerprint).map(e => e.epoch);
    const fresh = new Map<number, { nodes: NodeRow[]; pairs: PairRow[] }>();
    for (const [lo, hi] of runsOf(changed)) {
      const { nodes, pairs } = await nodesAndPairs(excluded, lo * EPOCH_BLOCKS, (hi + 1) * EPOCH_BLOCKS);
      for (let e = lo; e <= hi; e++) fresh.set(e, { nodes: [], pairs: [] });
      for (const n of nodes) fresh.get(n.epoch)!.nodes.push(n);
      for (const p of pairs) fresh.get(p.epoch)!.pairs.push(p);
    }
    const epochs = new Map<number, EpochRows>();
    for (const e of counted) {
      const rows = fresh.get(e.epoch) ?? prev.get(e.epoch)!;
      epochs.set(e.epoch, { fingerprint: e.fingerprint, heights: e.heights, nodes: rows.nodes, pairs: rows.pairs });
    }
    Object.assign(c, { scope, names, epochs });
    if (changed.length > 0) {
      const which = changed.length === counted.length ? 'all' : changed.join(', ');
      console.info(`Template sets: read ${changed.length} of ${counted.length} epochs (${which}) in ${Date.now() - started} ms`);
    }
    return epochs;
  } catch (error) {
    if (c.names !== names) throw error;
    console.error('Template sets: refresh failed, serving the last good rows:', error);
    return c.epochs;
  }
}

/** Ascending runs of consecutive epochs, as [first, last]. */
function runsOf(epochs: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const e of [...epochs].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && e === last[1] + 1) last[1] = e;
    else out.push([e, e]);
  }
  return out;
}

/** The wanted epochs' counted heights and rows, oldest first; epochs not counted are left out. */
function assemble(epochs: Map<number, EpochRows>, want: number[]): EpochGroupInputs {
  const out: EpochGroupInputs = { nodes: [], pairs: [], counted: [] };
  for (const e of [...new Set(want)].sort((a, b) => a - b)) {
    const r = epochs.get(e);
    if (!r) continue;
    out.counted.push({ epoch: e, heights: r.heights });
    for (const n of r.nodes) out.nodes.push(n);
    for (const p of r.pairs) out.pairs.push(p);
  }
  return out;
}
