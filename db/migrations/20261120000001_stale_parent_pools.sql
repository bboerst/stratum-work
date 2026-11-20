-- migrate:up
-- Templates on a recorded stale block, for the Forks page (web/lib/db/unknown-parents.ts, getStaleEpisodePoolRows): a
-- summary per (stale block, pool) kept up to date by the backend (backend/stale_parents.py), so the page needn't read
-- every stale block's templates per request (a cold read took seconds for the last 52,416 blocks and up to ~20 s for
-- all history). The twin of unknown_parent_pools (20261119000003), for the parents that are blocks we recorded.
--
-- Facts only, counted from stored templates: no kind, no verdict. Whether the block is still stale is judged when the
-- table is read (stale_blocks.reorged_in_at IS NULL), so a block reorged back in drops out of the page without any
-- cleanup here. Rows are kept for every stale block, also one reorged in, and for every pool, also a hidden one.
--
-- Which templates: those at the block's height + 1 whose prev_hash is the block, received inside that height's window
-- (template_height_windows()), the window as it was when the row was computed (the backend recomputes a block while
-- its window is recent, and the backfill recomputes them all). Counts are the web's: de-duplicated as exact copies
-- across a pool's connections, one row per copy group, the first received (as unknown_parent_pools). No merge-mining
-- count: the coinbase columns aren't read, they are most of a template's bytes. Connection ranks: the pool's sources
-- ranked by (site, replica) in "C" collation (1 = a), over all of the pool's sources.
CREATE TABLE stale_parent_pools (
    prev_hash      bytea       NOT NULL,   -- the stale block, as templates.prev_hash (stratum word order)
    pool           text        NOT NULL,   -- sources.name
    n              integer     NOT NULL,   -- de-duplicated templates on the block from the pool
    first_received timestamptz NOT NULL,   -- the first of them received
    last_received  timestamptz NOT NULL,   -- the last
    conns          integer[]   NOT NULL,   -- the connection ranks that received any of them, ascending
    heights        jsonb       NOT NULL,   -- {height: templates} (one height: the block's + 1)
    nbits          jsonb       NOT NULL,   -- {nbits: templates}
    computed_at    timestamptz NOT NULL DEFAULT now(),   -- when this row was last recomputed
    PRIMARY KEY (prev_hash, pool)
);
COMMENT ON TABLE stale_parent_pools IS
    'Per (prev_hash, pool): counted facts about the templates built on a recorded stale block at its height + 1, inside that height''s window (backend/stale_parents.py). Judge "still stale" at read time against stale_blocks.reorged_in_at.';

-- One stale block's rows, recomputed from its templates at p_height received in [p_from, p_to] (the caller passes the
-- height window as values, so TimescaleDB excludes chunks and compressed batches by received_at and height). p_block
-- is the block hash in display order (stale_blocks.block_hash). Every pool's rows are upserted; rows of pools with no
-- template left there are deleted. Idempotent. Planned per call (EXECUTE), with the bounds' values.
CREATE FUNCTION stale_parent_pools_refresh(p_block bytea, p_height integer, p_from timestamptz, p_to timestamptz)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE
    written integer;
BEGIN
    EXECUTE $q$
    WITH src AS (
      SELECT id, name, dense_rank() OVER (PARTITION BY name ORDER BY site COLLATE "C", replica COLLATE "C")::int AS conn
        FROM sources
    ), c AS (
      SELECT t.height, t.source_id, t.prev_hash, t.received_at, t.merkle_branches, t.version, t.nbits, t.ntime,
             t.job_id, s.name AS pool, s.conn
        FROM templates t JOIN src s ON s.id = t.source_id
       WHERE t.height = $2 AND t.received_at >= $3 AND t.received_at <= $4 AND t.prev_hash = $1
    ), k AS (
      SELECT c.*, row_number() OVER (PARTITION BY c.height, c.pool, c.source_id, c.prev_hash, c.merkle_branches,
                                                  c.version, c.nbits, c.ntime
                                     ORDER BY c.received_at, c.job_id) AS copy_no
        FROM c
    ), d AS (
      SELECT DISTINCT ON (k.height, k.pool, k.prev_hash, k.merkle_branches, k.version, k.nbits, k.ntime, k.copy_no) k.*
        FROM k
       ORDER BY k.height, k.pool, k.prev_hash, k.merkle_branches, k.version, k.nbits, k.ntime, k.copy_no,
                k.received_at, k.source_id, k.job_id
    ), g AS (
      SELECT pool, count(*)::int AS n, min(received_at) AS first_received, max(received_at) AS last_received
        FROM d GROUP BY pool
    ), hc AS (
      SELECT pool, jsonb_object_agg(height, n) AS heights
        FROM (SELECT pool, height, count(*) AS n FROM d GROUP BY 1, 2) x GROUP BY pool
    ), nc AS (
      SELECT pool, jsonb_object_agg(nbits, n) AS nbits
        FROM (SELECT pool, nbits, count(*) AS n FROM d GROUP BY 1, 2) x GROUP BY pool
    ), cc AS (
      SELECT pool, array_agg(DISTINCT conn ORDER BY conn) AS conns FROM k GROUP BY pool
    ), r AS (
      SELECT g.pool, g.n, g.first_received, g.last_received, cc.conns, hc.heights, nc.nbits
        FROM g JOIN hc USING (pool) JOIN nc USING (pool) JOIN cc USING (pool)
    ), up AS (
      INSERT INTO stale_parent_pools AS u (prev_hash, pool, n, first_received, last_received, conns, heights, nbits,
                                           computed_at)
      SELECT $1, r.pool, r.n, r.first_received, r.last_received, r.conns, r.heights, r.nbits, now() FROM r
      ON CONFLICT (prev_hash, pool) DO UPDATE SET
        n = EXCLUDED.n, first_received = EXCLUDED.first_received, last_received = EXCLUDED.last_received,
        conns = EXCLUDED.conns, heights = EXCLUDED.heights, nbits = EXCLUDED.nbits, computed_at = EXCLUDED.computed_at
      RETURNING 1
    ), gone AS (
      DELETE FROM stale_parent_pools u WHERE u.prev_hash = $1 AND NOT EXISTS (SELECT 1 FROM r WHERE r.pool = u.pool)
    )
    SELECT count(*)::int FROM up
    $q$ INTO written USING stratum_prev_hash_to_block_hash(p_block), p_height, p_from, p_to;
    RETURN written;
END
$fn$;

GRANT SELECT, INSERT, UPDATE, DELETE ON stale_parent_pools TO stratum_backend;
GRANT SELECT ON stale_parent_pools TO stratum_web;
REVOKE EXECUTE ON FUNCTION stale_parent_pools_refresh(bytea, integer, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION stale_parent_pools_refresh(bytea, integer, timestamptz, timestamptz) TO stratum_backend;

-- migrate:down
DROP FUNCTION stale_parent_pools_refresh(bytea, integer, timestamptz, timestamptz);
DROP TABLE stale_parent_pools;
