-- migrate:up
-- Unknown parents over any range (/unknown-parents, web/lib/db/unknown-parents.ts): a summary per (unknown parent,
-- pool) kept up to date by the backend (backend/unknown_parents.py), so the page needn't scan months of templates per
-- request (90 days took seconds; all history about a minute, beyond the web's statement timeout).
--
-- Facts only, counted from stored templates: no kind, no verdict. Whether a parent is still unknown is judged when the
-- table is read (NOT EXISTS in bitcoin_parents), so a parent later recorded as a block or a stale block drops out of
-- the page without any cleanup here; its row stays, true to the templates.
--
-- Counts are the web's: templates de-duplicated as exact copies across a pool's connections (the templates_copies
-- key (height, pool, prev_hash, merkle_branches, version, nbits, ntime) plus the copy number per connection), one
-- row per copy group, the first received. Connection ranks: the pool's sources ranked by (site, replica) in "C"
-- collation (1 = a), over all of the pool's sources.
CREATE TABLE unknown_parent_pools (
    prev_hash      bytea       NOT NULL,   -- the parent, as templates.prev_hash (stratum word order)
    pool           text        NOT NULL,   -- sources.name
    n              integer     NOT NULL,   -- de-duplicated templates on the parent from the pool
    first_received timestamptz NOT NULL,   -- the first of them received
    last_received  timestamptz NOT NULL,   -- the last
    auxpow         integer     NOT NULL,   -- of n, those with the merge-mining magic in coinbase1 or coinbase2
    conns          integer[]   NOT NULL,   -- the connection ranks that received any of them, ascending
    heights        jsonb       NOT NULL,   -- {height: templates}
    nbits          jsonb       NOT NULL,   -- {nbits: templates}
    computed_at    timestamptz NOT NULL DEFAULT now(),   -- when this row was last recomputed
    PRIMARY KEY (prev_hash, pool)
);
COMMENT ON TABLE unknown_parent_pools IS
    'Per (prev_hash, pool): counted facts about the templates built on a parent that was no known block when the backend last recomputed it (backend/unknown_parents.py). Judge "still unknown" at read time against bitcoin_parents.';

-- One parent's rows, recomputed from every template on it within the bounds given: heights and a receive-time range
-- that contain all of its templates (the caller passes them as values, so TimescaleDB excludes chunks and compressed
-- batches by received_at and height). Every pool's rows are upserted; rows of pools with no template left there are
-- deleted. Idempotent. Planned per call (EXECUTE), with the bounds' values.
CREATE FUNCTION unknown_parent_pools_refresh(p_prev_hash bytea, p_heights integer[], p_from timestamptz,
                                             p_to timestamptz)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE
    written integer;
BEGIN
    EXECUTE $q$
    WITH src AS (
      SELECT id, name, dense_rank() OVER (PARTITION BY name ORDER BY site COLLATE "C", replica COLLATE "C")::int AS conn
        FROM sources
    ), c AS (
      SELECT t.*, s.name AS pool, s.conn FROM templates t JOIN src s ON s.id = t.source_id
       WHERE t.prev_hash = $1 AND t.height = ANY ($2) AND t.received_at >= $3 AND t.received_at <= $4
    ), k AS (
      SELECT c.*, row_number() OVER (PARTITION BY c.height, c.pool, c.source_id, c.prev_hash, c.merkle_branches,
                                                  c.version, c.nbits, c.ntime
                                     ORDER BY c.received_at, c.job_id, c.coinbase1, c.coinbase2) AS copy_no
        FROM c
    ), d AS (
      SELECT DISTINCT ON (k.height, k.pool, k.prev_hash, k.merkle_branches, k.version, k.nbits, k.ntime, k.copy_no) k.*
        FROM k
       ORDER BY k.height, k.pool, k.prev_hash, k.merkle_branches, k.version, k.nbits, k.ntime, k.copy_no,
                k.received_at, k.source_id, k.job_id
    ), g AS (
      SELECT pool, count(*)::int AS n, min(received_at) AS first_received, max(received_at) AS last_received,
             count(*) FILTER (WHERE position('\xfabe6d6d'::bytea IN coinbase1) > 0
                                 OR position('\xfabe6d6d'::bytea IN coinbase2) > 0)::int AS auxpow
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
      SELECT g.pool, g.n, g.first_received, g.last_received, g.auxpow, cc.conns, hc.heights, nc.nbits
        FROM g JOIN hc USING (pool) JOIN nc USING (pool) JOIN cc USING (pool)
    ), up AS (
      INSERT INTO unknown_parent_pools AS u (prev_hash, pool, n, first_received, last_received, auxpow, conns, heights,
                                             nbits, computed_at)
      SELECT $1, r.pool, r.n, r.first_received, r.last_received, r.auxpow, r.conns, r.heights, r.nbits, now() FROM r
      ON CONFLICT (prev_hash, pool) DO UPDATE SET
        n = EXCLUDED.n, first_received = EXCLUDED.first_received, last_received = EXCLUDED.last_received,
        auxpow = EXCLUDED.auxpow, conns = EXCLUDED.conns, heights = EXCLUDED.heights, nbits = EXCLUDED.nbits,
        computed_at = EXCLUDED.computed_at
      RETURNING 1
    ), gone AS (
      DELETE FROM unknown_parent_pools u WHERE u.prev_hash = $1 AND NOT EXISTS (SELECT 1 FROM r WHERE r.pool = u.pool)
    )
    SELECT count(*)::int FROM up
    $q$ INTO written USING p_prev_hash, p_heights, p_from, p_to;
    RETURN written;
END
$fn$;

GRANT SELECT, INSERT, UPDATE, DELETE ON unknown_parent_pools TO stratum_backend;
GRANT SELECT ON unknown_parent_pools TO stratum_web;
REVOKE EXECUTE ON FUNCTION unknown_parent_pools_refresh(bytea, integer[], timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unknown_parent_pools_refresh(bytea, integer[], timestamptz, timestamptz) TO stratum_backend;

-- migrate:down
DROP FUNCTION unknown_parent_pools_refresh(bytea, integer[], timestamptz, timestamptz);
DROP TABLE unknown_parent_pools;
