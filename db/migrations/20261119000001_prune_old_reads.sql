-- migrate:up
-- Prune what nothing reads any more (after the one-templates-table migration, docs/design/one-templates-table.md):
-- - The views templates_copies / templates_dedup: they filter by height only, so since every template is in
--   `templates` they include late re-sends and other chains' rows at a height, and plan every chunk whose height
--   range overlaps. The functions of the same names with a height range and a receive window
--   (20261118000006; bounds from height_window()) replace them; no application reads the views.
-- - template_dedup_report(): its only caller was the replica comparison tool, removed with this change.
-- - The schema of the deleted history backfill tool (tools/mongo-to-postgres), if a database has it: the tool's own
--   bookkeeping (per-day reports, duplicates, re-routed rows), read by nothing.
DROP FUNCTION template_dedup_report(timestamptz, timestamptz);
DROP VIEW templates_dedup;
DROP VIEW templates_copies;
DROP SCHEMA IF EXISTS mongo_to_postgres CASCADE;

-- migrate:down
-- The views and the report as before (20261116200001 / 20261118000006). The backfill tool's schema isn't recreated.
CREATE VIEW templates_copies WITH (security_invoker = true) AS
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
      ) o
    WINDOW copy_w AS (PARTITION BY o.height, o.pool, o.prev_hash, o.merkle_branches, o.version, o.nbits, o.ntime, o.copy_no),
           key_w  AS (PARTITION BY o.height, o.pool, o.prev_hash, o.merkle_branches, o.version, o.nbits, o.ntime),
           job_w  AS (PARTITION BY o.height, o.pool, o.prev_hash, o.merkle_branches, o.version, o.nbits),
           active_w AS (PARTITION BY o.height, o.pool ORDER BY o.received_at
                        RANGE BETWEEN template_stream_silence() PRECEDING AND template_stream_lead() FOLLOWING)
  ) c;

CREATE VIEW templates_dedup WITH (security_invoker = true) AS
SELECT height, pool, prev_hash, merkle_branches, version, nbits, ntime, first_seen, received_at, copies,
       ARRAY(SELECT DISTINCT r FROM unnest(copy_replicas) r ORDER BY r) AS replicas,
       ARRAY(SELECT DISTINCT x FROM unnest(copy_sites) x ORDER BY x) AS sites,
       (SELECT jsonb_object_agg(u.site, u.first) FROM (SELECT v.site, min(v.t) AS first
          FROM unnest(copy_sites, copy_times) v(site, t) GROUP BY v.site) u) AS site_first_seen,
       is_primary, class, source_id, site, replica, received_at_offset_s, job_id, coinbase1, coinbase2, clean_jobs,
       extranonce1, extranonce2_length, latency_ms, latency_method
  FROM templates_copies
 WHERE class IN ('primary', 'gap_fill');

CREATE FUNCTION template_dedup_report(from_ts timestamptz, to_ts timestamptz)
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

GRANT SELECT ON templates_copies, templates_dedup TO stratum_backend, stratum_web;
REVOKE EXECUTE ON FUNCTION template_dedup_report(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION template_dedup_report(timestamptz, timestamptz) TO stratum_backend, stratum_web;
