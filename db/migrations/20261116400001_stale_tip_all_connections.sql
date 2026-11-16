-- migrate:up
-- stale_tip_templates() over every connection (#200, follow-up to 20261116100001_stale_blocks.sql and
-- 20261116200001_one_stream_per_pool.sql).
--
-- The function read templates_dedup. Since one stream per pool, that view shows one connection's rows per pool and
-- hides a secondary connection's own jobs while the primary is up ('secondary_stream'). For a pool that gives each
-- connection its own jobs, a secondary connection's templates on a stale tip went uncounted, so templates,
-- last_template_at and mined_after_switch could come out short. A stale-tip summary asks "did this pool still mine
-- on the losing tip, and until when", which any connection answers, so it now reads raw templates (every collector,
-- every row), like the analytics do.
--
-- Exact copies (same pool, height, prev_hash, merkle_branches, version, nbits, ntime; no tolerance) are counted once
-- per pool, matched one-to-one as in templates_copies: a template sent n times on one connection and m times on
-- another counts max(n, m). With one connection per pool the count is the raw row count, as before. first/last
-- template times are the earliest and latest received_at over all of the pool's rows on that prev_hash.
-- Output columns and every other rule are unchanged (CREATE OR REPLACE keeps the grants).
--
-- Cost: two hash aggregations over the height range's rows instead of templates_dedup's window sorts; the height
-- filter still goes to the templates height index / the columnstore's height metadata. Always give a height range.

-- Templates built on a tip other than the best chain's block at height - 1, per height, pool and prev_hash, for a
-- height range (always give one: the read goes through the templates height index / columnstore height metadata).
--   tip = 'stale'    prev_hash is a recorded stale block (stale_block_hash, with its height, pool, reorg)
--         'unknown'  prev_hash is neither the best block at height - 1 nor a recorded stale block (a tip the node
--                    never heard of, e.g. a block that lost the race before it reached us)
-- Heights whose best block at height - 1 isn't in blocks are only reported for recorded stale blocks: without the
-- best block there is nothing to compare an unknown prev_hash with. The best block at height - 1 is the blocks row
-- there that isn't currently stale (stale_blocks.reorged_in_at IS NULL); blocks keeps reorged-out blocks too.
-- Template counts come from templates (every connection), exact copies across connections counted once per pool;
-- first_template_at / last_template_at are the earliest / latest receive time over that pool's rows on that prev_hash.
-- node_switch_at: when our node moved past this tip: the reorg's detection time if our node had it as its tip,
-- otherwise when the backend saw the best block at height - 1 (blocks.seen_at). mined_after_switch =
-- last_template_at - node_switch_at (negative: the pool had moved on before our node had the winning block).
-- templates holds Bitcoin templates only (other chains go to templates_other), so no chain filter is needed.
CREATE OR REPLACE FUNCTION stale_tip_templates(from_height integer, to_height integer)
RETURNS TABLE (
    height integer, pool text, prev_hash bytea, prev_block_hash bytea, tip text,
    stale_block_hash bytea, stale_height integer, stale_full_block boolean, stale_mining_pool jsonb,
    stale_was_active boolean, reorg_id bigint, best_block_hash bytea,
    templates bigint, first_template_at timestamptz, last_template_at timestamptz,
    node_switch_at timestamptz, mined_after_switch interval
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH per_source AS (   -- each exact template, per connection: how often it sent it, and when
    SELECT t.height, s.name AS pool, t.prev_hash, t.merkle_branches, t.version, t.nbits, t.ntime,
           count(*) AS n, min(t.received_at) AS first_at, max(t.received_at) AS last_at
      FROM templates t
      JOIN sources s ON s.id = t.source_id
     WHERE t.height BETWEEN from_height AND to_height
     GROUP BY t.height, s.name, t.source_id, t.prev_hash, t.merkle_branches, t.version, t.nbits, t.ntime
  ), per_key AS (       -- each exact template, per pool: copies on other connections matched one-to-one
    SELECT p.height, p.pool, p.prev_hash, max(p.n) AS n, min(p.first_at) AS first_at, max(p.last_at) AS last_at
      FROM per_source p
     GROUP BY p.height, p.pool, p.prev_hash, p.merkle_branches, p.version, p.nbits, p.ntime
  ), g AS (
    SELECT k.height, k.pool, k.prev_hash, stratum_prev_hash_to_block_hash(k.prev_hash) AS prev_block_hash,
           sum(k.n)::bigint AS n, min(k.first_at) AS first_at, max(k.last_at) AS last_at
      FROM per_key k
     GROUP BY k.height, k.pool, k.prev_hash
  ), best AS (
    SELECT b.height, b.block_hash, b.seen_at
      FROM blocks b
     WHERE b.height BETWEEN from_height - 1 AND to_height - 1
       AND NOT EXISTS (SELECT 1 FROM stale_blocks x WHERE x.block_hash = b.block_hash AND x.reorged_in_at IS NULL)
  ), c AS (
    SELECT g.*,
           EXISTS (SELECT 1 FROM best WHERE best.height = g.height - 1 AND best.block_hash = g.prev_block_hash) AS on_best,
           (SELECT best.block_hash FROM best WHERE best.height = g.height - 1
             ORDER BY best.seen_at NULLS LAST, best.block_hash LIMIT 1) AS best_hash,
           (SELECT best.seen_at FROM best WHERE best.height = g.height - 1
             ORDER BY best.seen_at NULLS LAST, best.block_hash LIMIT 1) AS best_seen_at
      FROM g
  )
  SELECT c.height, c.pool, c.prev_hash, c.prev_block_hash,
         CASE WHEN s.block_hash IS NOT NULL THEN 'stale' ELSE 'unknown' END,
         s.block_hash, s.height, s.full_block, s.mining_pool, s.was_active, s.reorg_id, c.best_hash,
         c.n, c.first_at, c.last_at,
         COALESCE(r.detected_at, c.best_seen_at),
         c.last_at - COALESCE(r.detected_at, c.best_seen_at)
    FROM c
    LEFT JOIN stale_blocks s ON s.block_hash = c.prev_block_hash AND s.reorged_in_at IS NULL
    LEFT JOIN chain_reorgs r ON r.id = s.reorg_id
   WHERE NOT c.on_best
     AND (s.block_hash IS NOT NULL OR c.best_hash IS NOT NULL)
   ORDER BY c.height DESC, c.first_at, c.pool
$$;

-- migrate:down
-- The body of 20261116100001_stale_blocks.sql (templates_dedup).
CREATE OR REPLACE FUNCTION stale_tip_templates(from_height integer, to_height integer)
RETURNS TABLE (
    height integer, pool text, prev_hash bytea, prev_block_hash bytea, tip text,
    stale_block_hash bytea, stale_height integer, stale_full_block boolean, stale_mining_pool jsonb,
    stale_was_active boolean, reorg_id bigint, best_block_hash bytea,
    templates bigint, first_template_at timestamptz, last_template_at timestamptz,
    node_switch_at timestamptz, mined_after_switch interval
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH g AS (
    SELECT d.height, d.pool, d.prev_hash, stratum_prev_hash_to_block_hash(d.prev_hash) AS prev_block_hash,
           count(*) AS n, min(d.first_seen) AS first_at, max(d.received_at) AS last_at
      FROM templates_dedup d
     WHERE d.height BETWEEN from_height AND to_height
     GROUP BY d.height, d.pool, d.prev_hash
  ), best AS (
    SELECT b.height, b.block_hash, b.seen_at
      FROM blocks b
     WHERE b.height BETWEEN from_height - 1 AND to_height - 1
       AND NOT EXISTS (SELECT 1 FROM stale_blocks x WHERE x.block_hash = b.block_hash AND x.reorged_in_at IS NULL)
  ), c AS (
    SELECT g.*,
           EXISTS (SELECT 1 FROM best WHERE best.height = g.height - 1 AND best.block_hash = g.prev_block_hash) AS on_best,
           (SELECT best.block_hash FROM best WHERE best.height = g.height - 1
             ORDER BY best.seen_at NULLS LAST, best.block_hash LIMIT 1) AS best_hash,
           (SELECT best.seen_at FROM best WHERE best.height = g.height - 1
             ORDER BY best.seen_at NULLS LAST, best.block_hash LIMIT 1) AS best_seen_at
      FROM g
  )
  SELECT c.height, c.pool, c.prev_hash, c.prev_block_hash,
         CASE WHEN s.block_hash IS NOT NULL THEN 'stale' ELSE 'unknown' END,
         s.block_hash, s.height, s.full_block, s.mining_pool, s.was_active, s.reorg_id, c.best_hash,
         c.n, c.first_at, c.last_at,
         COALESCE(r.detected_at, c.best_seen_at),
         c.last_at - COALESCE(r.detected_at, c.best_seen_at)
    FROM c
    LEFT JOIN stale_blocks s ON s.block_hash = c.prev_block_hash AND s.reorged_in_at IS NULL
    LEFT JOIN chain_reorgs r ON r.id = s.reorg_id
   WHERE NOT c.on_best
     AND (s.block_hash IS NOT NULL OR c.best_hash IS NOT NULL)
   ORDER BY c.height DESC, c.first_at, c.pool
$$;
