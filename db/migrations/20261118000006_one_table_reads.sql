-- migrate:up
-- One templates table, step 1 (docs/design/one-templates-table.md): height reads that don't depend on the collectors'
-- chain classification. A template's height alone doesn't say it's Bitcoin's or current: a stuck feed re-sends an old
-- job hours later at its old height, and another chain's heights can pass through a past Bitcoin height. Its
-- RECEIVE TIME does: a template for height h is received between the block at h - 1 arriving and the block at h
-- arriving. So height reads also bound received_at, from stored facts (blocks), at read time.
--
-- Nothing here moves or drops data: templates still holds what the collectors route to it, and the old views stay until
-- templates_other is dropped (step 4), so a web rollback keeps working. Callers move to the functions in step 1's code.

-- Per height in [h_from, h_to]: the window its templates are received in. From the arrival of the block at h - 1 to
-- the arrival of the block at h, widened by 2 h on each side (the consensus limit on a header time running ahead, so
-- it also holds for backfilled blocks timed by their header). Arrival = earliest coalesce(seen_at, block_time) at
-- that height. A height without a stored block uses the nearest stored block below / above: the window widens, never
-- opens. Above the stored tip (the height being mined now) the window is open-ended; below the first block, too.
CREATE FUNCTION template_height_windows(h_from integer, h_to integer)
RETURNS TABLE (height integer, w_from timestamptz, w_to timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT h,
         coalesce((SELECT min(coalesce(b.seen_at, b.block_time)) FROM blocks b
                    WHERE b.height = (SELECT max(b2.height) FROM blocks b2 WHERE b2.height <= h - 1))
                  - interval '2 hours', '-infinity'::timestamptz),
         coalesce((SELECT min(coalesce(b.seen_at, b.block_time)) FROM blocks b
                    WHERE b.height = (SELECT min(b2.height) FROM blocks b2 WHERE b2.height >= h))
                  + interval '2 hours', 'infinity'::timestamptz)
    FROM generate_series(h_from, h_to) h
$$;

-- The receive-time range covering every height window in [h_from, h_to]. Readers fetch it first, in its own round trip,
-- and pass it to the reads below AS VALUES (literals or parameters of a custom plan): only then does TimescaleDB drop
-- the chunks outside it at planning. Computed inside the same query (a subquery or a function call), it doesn't.
CREATE FUNCTION height_window(h_from integer, h_to integer)
RETURNS TABLE (t_from timestamptz, t_to timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT min(w.w_from), max(w.w_to) FROM template_height_windows(h_from, h_to) w
$$;

-- Prev hashes that are Bitcoin blocks we know, in stratum's word order (stratum_prev_hash_to_block_hash is its own
-- inverse), so templates join on their raw prev_hash. Converting once per block, not per template (design section 4).
CREATE VIEW bitcoin_parents WITH (security_invoker = true) AS
SELECT stratum_prev_hash_to_block_hash(b.block_hash) AS prev_hash, b.block_hash, b.height, 'blocks'::text AS source
  FROM blocks b
UNION ALL
SELECT stratum_prev_hash_to_block_hash(s.block_hash), s.block_hash, s.height, 'stale_blocks'
  FROM stale_blocks s;

-- templates_copies / templates_dedup with bounds: the views' exact bodies (20261116200001), with the height range and
-- the receive-time range applied to templates BEFORE the de-duplication windows, so a stale re-send can't become a
-- pool's primary row and the bounds reach chunk exclusion. LANGUAGE sql, STABLE, one statement, not STRICT: Postgres
-- inlines them, so the bounds are planned as if written in the caller's query. Pass the time range from
-- height_window() for a height read, or '-infinity' / 'infinity' to read every row at those heights.
CREATE FUNCTION templates_copies(h_from integer, h_to integer, t_from timestamptz, t_to timestamptz)
RETURNS TABLE (
    height integer, pool text, site text, replica text, source_id smallint, received_at timestamptz,
    received_at_offset_s integer, job_id text, prev_hash bytea, coinbase1 bytea, coinbase2 bytea,
    merkle_branches bytea, version bigint, nbits bigint, ntime bigint, clean_jobs boolean, extranonce1 bytea,
    extranonce2_length smallint, latency_ms real, latency_method latency_method, is_primary boolean, copy_no bigint,
    class text, first_seen timestamptz, copies bigint, copy_replicas text[], copy_sites text[],
    copy_times timestamptz[], primary_received_at timestamptz, primary_match text, source_rank integer,
    active_rank integer
)
LANGUAGE sql STABLE AS $$
SELECT c.height, c.pool, c.site, c.replica, c.source_id, c.received_at, c.received_at_offset_s, c.job_id,
       c.prev_hash, c.coinbase1, c.coinbase2, c.merkle_branches, c.version, c.nbits, c.ntime, c.clean_jobs,
       c.extranonce1, c.extranonce2_length, c.latency_ms, c.latency_method,
       c.is_primary, c.copy_no,
       CASE WHEN c.is_primary THEN 'primary' WHEN c.primary_copy THEN 'copy'
            WHEN c.active_rank < c.source_rank THEN 'secondary_stream' ELSE 'gap_fill' END AS class,
       CASE WHEN c.is_primary THEN c.copy_first_seen ELSE c.received_at END AS first_seen,
       CASE WHEN c.is_primary THEN c.copy_count ELSE 1 END AS copies,
       CASE WHEN c.is_primary THEN c.copy_replicas ELSE ARRAY[c.replica] END AS copy_replicas,
       CASE WHEN c.is_primary THEN c.copy_sites ELSE ARRAY[c.site] END AS copy_sites,
       CASE WHEN c.is_primary THEN c.copy_times ELSE ARRAY[c.received_at] END AS copy_times,
       c.primary_received_at,  -- the matched primary row's own received_at ('primary' and 'copy' rows)
       CASE WHEN c.is_primary THEN NULL WHEN c.primary_copy THEN 'copy' WHEN c.primary_has_key THEN 'extra'
            WHEN c.primary_has_job THEN 'near_miss' ELSE 'other_job' END AS primary_match,
       c.source_rank,          -- 1 = the pool's first source by (site, replica)
       c.active_rank           -- the lowest-ranked source with a row in the activity window around this row
  FROM (
    SELECT o.*,
           bool_or(o.is_primary)  OVER copy_w AS primary_copy,     -- this copy number of this key has a primary row
           min(o.received_at)     OVER copy_w AS copy_first_seen,
           count(*)               OVER copy_w AS copy_count,
           array_agg(o.replica)   OVER copy_w AS copy_replicas,
           array_agg(o.site)      OVER copy_w AS copy_sites,
           array_agg(o.received_at) OVER copy_w AS copy_times,
           max(o.received_at) FILTER (WHERE o.is_primary) OVER copy_w AS primary_received_at,
           bool_or(o.is_primary)  OVER key_w  AS primary_has_key,  -- the primary has this exact template
           bool_or(o.is_primary)  OVER job_w  AS primary_has_job,  -- ... or the same job with another ntime
           min(o.source_rank)     OVER active_w AS active_rank
      FROM (
        SELECT t.*, s.name AS pool, s.site, s.replica, s.source_rank,
               s.source_rank = min(s.source_rank) OVER (PARTITION BY t.height, s.name) AS is_primary,
               row_number() OVER (PARTITION BY t.height, s.name, t.source_id, t.prev_hash, t.merkle_branches,
                                               t.version, t.nbits, t.ntime
                                  ORDER BY t.received_at, t.job_id, t.coinbase1, t.coinbase2) AS copy_no
          FROM templates t
          JOIN (SELECT id, name, site, replica,
                       dense_rank() OVER (PARTITION BY name ORDER BY site COLLATE "C", replica COLLATE "C")::integer
                         AS source_rank
                  FROM sources) s ON s.id = t.source_id
         WHERE t.height BETWEEN h_from AND h_to AND t.received_at >= t_from AND t.received_at <= t_to
      ) o
    WINDOW copy_w AS (PARTITION BY o.height, o.pool, o.prev_hash, o.merkle_branches, o.version, o.nbits, o.ntime, o.copy_no),
           key_w  AS (PARTITION BY o.height, o.pool, o.prev_hash, o.merkle_branches, o.version, o.nbits, o.ntime),
           job_w  AS (PARTITION BY o.height, o.pool, o.prev_hash, o.merkle_branches, o.version, o.nbits),
           active_w AS (PARTITION BY o.height, o.pool ORDER BY o.received_at
                        RANGE BETWEEN template_stream_silence() PRECEDING AND template_stream_lead() FOLLOWING)
  ) c
$$;

CREATE FUNCTION templates_dedup(h_from integer, h_to integer, t_from timestamptz, t_to timestamptz)
RETURNS TABLE (
    height integer, pool text, prev_hash bytea, merkle_branches bytea, version bigint, nbits bigint, ntime bigint,
    first_seen timestamptz, received_at timestamptz, copies bigint, replicas text[], sites text[],
    site_first_seen jsonb, is_primary boolean, class text, source_id smallint, site text, replica text,
    received_at_offset_s integer, job_id text, coinbase1 bytea, coinbase2 bytea, clean_jobs boolean,
    extranonce1 bytea, extranonce2_length smallint, latency_ms real, latency_method latency_method
)
LANGUAGE sql STABLE AS $$
SELECT height, pool, prev_hash, merkle_branches, version, nbits, ntime, first_seen, received_at, copies,
       ARRAY(SELECT DISTINCT r FROM unnest(copy_replicas) r ORDER BY r) AS replicas,
       ARRAY(SELECT DISTINCT x FROM unnest(copy_sites) x ORDER BY x) AS sites,
       (SELECT jsonb_object_agg(u.site, u.first) FROM (SELECT v.site, min(v.t) AS first
          FROM unnest(copy_sites, copy_times) v(site, t) GROUP BY v.site) u) AS site_first_seen,
       is_primary, class, source_id, site, replica, received_at_offset_s, job_id, coinbase1, coinbase2, clean_jobs,
       extranonce1, extranonce2_length, latency_ms, latency_method
  FROM templates_copies(h_from, h_to, t_from, t_to)
 WHERE class IN ('primary', 'gap_fill')
$$;

-- stale_tip_templates: the same rules and output (20261116400001), reading only the rows inside each height's window,
-- so stale re-sends and other chains' templates at those heights don't count as templates on a stale or unknown tip.
-- PL/pgSQL with the range's window as literals (dynamic SQL) so chunk exclusion applies. CREATE OR REPLACE keeps the
-- grants.
CREATE OR REPLACE FUNCTION stale_tip_templates(from_height integer, to_height integer)
RETURNS TABLE (
    height integer, pool text, prev_hash bytea, prev_block_hash bytea, tip text,
    stale_block_hash bytea, stale_height integer, stale_full_block boolean, stale_mining_pool jsonb,
    stale_was_active boolean, reorg_id bigint, best_block_hash bytea,
    templates bigint, first_template_at timestamptz, last_template_at timestamptz,
    node_switch_at timestamptz, mined_after_switch interval
)
LANGUAGE plpgsql STABLE SECURITY INVOKER AS $fn$
DECLARE t_from timestamptz; t_to timestamptz;
BEGIN
  SELECT hw.t_from, hw.t_to INTO t_from, t_to FROM height_window(from_height, to_height) hw;
  RETURN QUERY EXECUTE format($q$
  WITH per_source AS (   -- each exact template, per connection: how often it sent it, and when
    SELECT t.height, s.name AS pool, t.prev_hash, t.merkle_branches, t.version, t.nbits, t.ntime,
           count(*) AS n, min(t.received_at) AS first_at, max(t.received_at) AS last_at
      FROM templates t
      JOIN sources s ON s.id = t.source_id
      JOIN template_height_windows(%1$s, %2$s) w ON w.height = t.height
                                                AND t.received_at >= w.w_from AND t.received_at <= w.w_to
     WHERE t.height BETWEEN %1$s AND %2$s AND t.received_at >= %3$L AND t.received_at <= %4$L
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
     WHERE b.height BETWEEN %1$s - 1 AND %2$s - 1
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
  $q$, from_height, to_height, t_from, t_to);
END $fn$;

-- template_dedup_report: the same report over templates_copies() bounded by the report's own time range (it already
-- reports rows received in it), so rows received outside it never enter the de-duplication.
CREATE OR REPLACE FUNCTION template_dedup_report(from_ts timestamptz, to_ts timestamptz)
RETURNS TABLE (
    day date, pool text, site text,
    rows bigint, primary_rows bigint, secondary_rows bigint, secondary_hidden bigint, secondary_shown bigint,
    extra_copies bigint, near_misses bigint,
    near_miss_ntime_1s bigint, near_miss_ntime_2s bigint, near_miss_ntime_3s bigint, near_miss_ntime_4_10s bigint,
    near_miss_ntime_over_10s bigint,
    gap_fills bigint,
    first_seen_gains bigint, gain_ms_p50 double precision, gain_ms_p95 double precision, gain_ms_max double precision,
    exact_copies bigint, secondary_stream bigint
)
LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE lo integer; hi integer;
BEGIN
  SELECT min(t.height), max(t.height) INTO lo, hi FROM templates t WHERE t.received_at >= from_ts AND t.received_at < to_ts;
  IF lo IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH x AS (
    SELECT c.*,
           -- near misses: |ntime difference| to the closest primary row of the same job (the nearest primary ntime
           -- below and above, from the window: no join)
           CASE WHEN c.primary_match = 'near_miss'
                THEN least(c.ntime - max(c.ntime) FILTER (WHERE c.is_primary) OVER below,
                           min(c.ntime) FILTER (WHERE c.is_primary) OVER above - c.ntime) END AS d,
           CASE WHEN c.class = 'primary' AND c.first_seen < c.received_at
                THEN extract(epoch FROM c.received_at - c.first_seen)::double precision * 1000 END AS pool_gain_ms,
           CASE WHEN c.class = 'copy' AND c.received_at < c.primary_received_at
                THEN extract(epoch FROM c.primary_received_at - c.received_at)::double precision * 1000 END AS site_gain_ms
      FROM templates_copies(lo, hi, from_ts, to_ts) c
    WINDOW below AS (PARTITION BY c.height, c.pool, c.prev_hash, c.merkle_branches, c.version, c.nbits ORDER BY c.ntime
                     ROWS UNBOUNDED PRECEDING),
           above AS (PARTITION BY c.height, c.pool, c.prev_hash, c.merkle_branches, c.version, c.nbits ORDER BY c.ntime
                     ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING)
  )
  SELECT (x.received_at AT TIME ZONE 'UTC')::date, x.pool, x.site,
         count(*),
         count(*) FILTER (WHERE x.is_primary),
         count(*) FILTER (WHERE NOT x.is_primary),
         count(*) FILTER (WHERE x.class IN ('copy', 'secondary_stream')),
         count(*) FILTER (WHERE x.class = 'gap_fill'),
         count(*) FILTER (WHERE x.primary_match = 'extra'),
         count(*) FILTER (WHERE x.primary_match = 'near_miss'),
         count(*) FILTER (WHERE x.d = 1),
         count(*) FILTER (WHERE x.d = 2),
         count(*) FILTER (WHERE x.d = 3),
         count(*) FILTER (WHERE x.d BETWEEN 4 AND 10),
         count(*) FILTER (WHERE x.d > 10),
         count(*) FILTER (WHERE x.class = 'gap_fill'),
         CASE WHEN GROUPING(x.site) = 1 THEN count(x.pool_gain_ms) ELSE count(x.site_gain_ms) END,
         CASE WHEN GROUPING(x.site) = 1 THEN percentile_cont(0.5) WITHIN GROUP (ORDER BY x.pool_gain_ms)
              ELSE percentile_cont(0.5) WITHIN GROUP (ORDER BY x.site_gain_ms) END,
         CASE WHEN GROUPING(x.site) = 1 THEN percentile_cont(0.95) WITHIN GROUP (ORDER BY x.pool_gain_ms)
              ELSE percentile_cont(0.95) WITHIN GROUP (ORDER BY x.site_gain_ms) END,
         CASE WHEN GROUPING(x.site) = 1 THEN max(x.pool_gain_ms) ELSE max(x.site_gain_ms) END,
         count(*) FILTER (WHERE x.class = 'copy'),
         count(*) FILTER (WHERE x.class = 'secondary_stream')
    FROM x
   WHERE x.received_at >= from_ts AND x.received_at < to_ts
   GROUP BY GROUPING SETS ((1, x.pool, x.site), (1, x.pool))
   ORDER BY 1, 2, 3 NULLS FIRST;
END $$;

GRANT SELECT ON bitcoin_parents TO stratum_backend, stratum_web;
REVOKE EXECUTE ON FUNCTION template_height_windows(integer, integer), height_window(integer, integer),
    templates_copies(integer, integer, timestamptz, timestamptz), templates_dedup(integer, integer, timestamptz, timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION template_height_windows(integer, integer), height_window(integer, integer),
    templates_copies(integer, integer, timestamptz, timestamptz), templates_dedup(integer, integer, timestamptz, timestamptz)
  TO stratum_backend, stratum_web;

-- migrate:down
-- stale_tip_templates changes language: drop and re-create it as 20261116400001 left it, with its grants.
DROP FUNCTION stale_tip_templates(integer, integer);
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
REVOKE EXECUTE ON FUNCTION stale_tip_templates(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION stale_tip_templates(integer, integer) TO stratum_backend, stratum_web;
CREATE OR REPLACE FUNCTION template_dedup_report(from_ts timestamptz, to_ts timestamptz)
RETURNS TABLE (
    day date, pool text, site text,
    rows bigint, primary_rows bigint, secondary_rows bigint, secondary_hidden bigint, secondary_shown bigint,
    extra_copies bigint, near_misses bigint,
    near_miss_ntime_1s bigint, near_miss_ntime_2s bigint, near_miss_ntime_3s bigint, near_miss_ntime_4_10s bigint,
    near_miss_ntime_over_10s bigint,
    gap_fills bigint,
    first_seen_gains bigint, gain_ms_p50 double precision, gain_ms_p95 double precision, gain_ms_max double precision,
    exact_copies bigint, secondary_stream bigint
)
LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE lo integer; hi integer;
BEGIN
  SELECT min(t.height), max(t.height) INTO lo, hi FROM templates t WHERE t.received_at >= from_ts AND t.received_at < to_ts;
  IF lo IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH x AS (
    SELECT c.*,
           -- near misses: |ntime difference| to the closest primary row of the same job (the nearest primary ntime
           -- below and above, from the window: no join)
           CASE WHEN c.primary_match = 'near_miss'
                THEN least(c.ntime - max(c.ntime) FILTER (WHERE c.is_primary) OVER below,
                           min(c.ntime) FILTER (WHERE c.is_primary) OVER above - c.ntime) END AS d,
           CASE WHEN c.class = 'primary' AND c.first_seen < c.received_at
                THEN extract(epoch FROM c.received_at - c.first_seen)::double precision * 1000 END AS pool_gain_ms,
           CASE WHEN c.class = 'copy' AND c.received_at < c.primary_received_at
                THEN extract(epoch FROM c.primary_received_at - c.received_at)::double precision * 1000 END AS site_gain_ms
      FROM templates_copies c
     WHERE c.height BETWEEN lo AND hi
    WINDOW below AS (PARTITION BY c.height, c.pool, c.prev_hash, c.merkle_branches, c.version, c.nbits ORDER BY c.ntime
                     ROWS UNBOUNDED PRECEDING),
           above AS (PARTITION BY c.height, c.pool, c.prev_hash, c.merkle_branches, c.version, c.nbits ORDER BY c.ntime
                     ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING)
  )
  SELECT (x.received_at AT TIME ZONE 'UTC')::date, x.pool, x.site,
         count(*),
         count(*) FILTER (WHERE x.is_primary),
         count(*) FILTER (WHERE NOT x.is_primary),
         count(*) FILTER (WHERE x.class IN ('copy', 'secondary_stream')),
         count(*) FILTER (WHERE x.class = 'gap_fill'),
         count(*) FILTER (WHERE x.primary_match = 'extra'),
         count(*) FILTER (WHERE x.primary_match = 'near_miss'),
         count(*) FILTER (WHERE x.d = 1),
         count(*) FILTER (WHERE x.d = 2),
         count(*) FILTER (WHERE x.d = 3),
         count(*) FILTER (WHERE x.d BETWEEN 4 AND 10),
         count(*) FILTER (WHERE x.d > 10),
         count(*) FILTER (WHERE x.class = 'gap_fill'),
         CASE WHEN GROUPING(x.site) = 1 THEN count(x.pool_gain_ms) ELSE count(x.site_gain_ms) END,
         CASE WHEN GROUPING(x.site) = 1 THEN percentile_cont(0.5) WITHIN GROUP (ORDER BY x.pool_gain_ms)
              ELSE percentile_cont(0.5) WITHIN GROUP (ORDER BY x.site_gain_ms) END,
         CASE WHEN GROUPING(x.site) = 1 THEN percentile_cont(0.95) WITHIN GROUP (ORDER BY x.pool_gain_ms)
              ELSE percentile_cont(0.95) WITHIN GROUP (ORDER BY x.site_gain_ms) END,
         CASE WHEN GROUPING(x.site) = 1 THEN max(x.pool_gain_ms) ELSE max(x.site_gain_ms) END,
         count(*) FILTER (WHERE x.class = 'copy'),
         count(*) FILTER (WHERE x.class = 'secondary_stream')
    FROM x
   WHERE x.received_at >= from_ts AND x.received_at < to_ts
   GROUP BY GROUPING SETS ((1, x.pool, x.site), (1, x.pool))
   ORDER BY 1, 2, 3 NULLS FIRST;
END $$;
DROP FUNCTION templates_dedup(integer, integer, timestamptz, timestamptz);
DROP FUNCTION templates_copies(integer, integer, timestamptz, timestamptz);
DROP VIEW bitcoin_parents;
DROP FUNCTION height_window(integer, integer);
DROP FUNCTION template_height_windows(integer, integer);
