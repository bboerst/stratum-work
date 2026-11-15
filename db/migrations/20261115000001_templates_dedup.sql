-- migrate:up
-- Redundant collection without double counting (see 20261114000001_sources_replica.sql). With several collectors per
-- pool (replicas, and during a migration several sites) every template is stored once per connection that saw it.
-- These views show each template once, without merging anything a pool sent on one connection:
--
-- * Primary: at each height, the pool's (sources.name) sources that have rows there are ordered by (site, replica);
--   the first is the primary, the others are secondaries. E.g. replica 'a' over 'b' at one site. Per height, so a
--   height the usual primary missed entirely (collector down) is served by the next source instead of being shown
--   twice. Every primary row is shown, exactly as stored: re-sends (same job, new ntime) and any other change are
--   separate rows, as with one collector. With one source per pool the views return exactly the raw rows.
-- * A secondary row is hidden only if it is an EXACT copy of a primary row: same height, pool, prev_hash,
--   merkle_branches, version, nbits AND ntime. No time or ntime tolerance. Per-connection fields (job_id,
--   extranonce1, coinbase1/2, latency, received_at) may differ. Matching is one-to-one: per source, the copies of a
--   key are numbered in receive order (copy_no), and a secondary's n-th copy hides the primary's n-th copy only.
-- * A shown primary row's first_seen is the earliest received_at over itself and the secondary copies it matched;
--   copies / replicas / sites say who saw it, and site_first_seen ({site: earliest received_at at that site}) keeps
--   each site's own time, so timing can be compared per region instead of mixing geographies into one minimum.
--   All its other columns are its own (the primary connection's coinbase).
-- * Several sites (regions): the rule is the same across sites. Hiding never compares clocks: a copy is matched by
--   identical fields and by its position among that source's own copies of the key (its own receive order), so clock
--   skew between sites only moves first_seen, never what is shown. Anything only a non-primary site saw is shown.
-- * Secondary rows without an exact primary copy are shown, with is_primary = false and class:
--     'extra'      the primary has that exact template, but fewer times (its copies are all matched)
--     'near_miss'  the primary has the same job (prev_hash, merkle_branches, version, nbits) with another ntime only
--     'gap_fill'   the primary has no row of that job at all
--
-- templates_copies     every row, classified ('primary', 'copy' = hidden, 'extra', 'near_miss', 'gap_fill')
-- templates_dedup      the rows to show (everything but 'copy'), what "templates at a height" reads use
-- templates_other_*    the same over templates_other (chain is part of every key)
-- template_dedup_report(from_ts, to_ts)   per pool, UTC day and site (plus a site = NULL total): what the
--                      de-duplication did (counts, near-miss ntime differences, first-seen gains); see
--                      docs/design/postgres-timescale.md
--
-- Cost: filters on height (or a height range, or pool) are pushed through the window functions down to the
-- templates_height_source_time index (uncompressed chunks) and the columnstore's height metadata (compressed chunks).
-- Two sorts of that height's rows. Without a height filter the views read the whole table: always filter on height.
-- security_invoker: a reader needs SELECT on the underlying tables itself (the views grant nothing extra).

CREATE VIEW templates_copies WITH (security_invoker = true) AS
SELECT c.height, c.pool, c.site, c.replica, c.source_id, c.received_at, c.received_at_offset_s, c.job_id,
       c.prev_hash, c.coinbase1, c.coinbase2, c.merkle_branches, c.version, c.nbits, c.ntime, c.clean_jobs,
       c.extranonce1, c.extranonce2_length, c.latency_ms, c.latency_method,
       c.is_primary, c.copy_no,
       CASE WHEN c.is_primary THEN 'primary' WHEN c.primary_copy THEN 'copy' WHEN c.primary_has_key THEN 'extra'
            WHEN c.primary_has_job THEN 'near_miss' ELSE 'gap_fill' END AS class,
       CASE WHEN c.is_primary THEN c.copy_first_seen ELSE c.received_at END AS first_seen,
       CASE WHEN c.is_primary THEN c.copy_count ELSE 1 END AS copies,
       CASE WHEN c.is_primary THEN c.copy_replicas ELSE ARRAY[c.replica] END AS copy_replicas,
       CASE WHEN c.is_primary THEN c.copy_sites ELSE ARRAY[c.site] END AS copy_sites,
       CASE WHEN c.is_primary THEN c.copy_times ELSE ARRAY[c.received_at] END AS copy_times,
       c.primary_received_at   -- the matched primary row's own received_at ('primary' and 'copy' rows)
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
           bool_or(o.is_primary)  OVER job_w  AS primary_has_job   -- ... or the same job with another ntime
      FROM (
        SELECT t.*, s.name AS pool, s.site, s.replica,
               ARRAY[s.site, s.replica] = min(ARRAY[s.site, s.replica]) OVER (PARTITION BY t.height, s.name)
                 AS is_primary,
               row_number() OVER (PARTITION BY t.height, s.name, t.source_id, t.prev_hash, t.merkle_branches,
                                               t.version, t.nbits, t.ntime
                                  ORDER BY t.received_at, t.job_id, t.coinbase1, t.coinbase2) AS copy_no
          FROM templates t JOIN sources s ON s.id = t.source_id
      ) o
    WINDOW copy_w AS (PARTITION BY o.height, o.pool, o.prev_hash, o.merkle_branches, o.version, o.nbits, o.ntime, o.copy_no),
           key_w  AS (PARTITION BY o.height, o.pool, o.prev_hash, o.merkle_branches, o.version, o.nbits, o.ntime),
           job_w  AS (PARTITION BY o.height, o.pool, o.prev_hash, o.merkle_branches, o.version, o.nbits)
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
 WHERE class <> 'copy';

-- The same over templates_other: chain is part of every key; reason is the row's own.
CREATE VIEW templates_other_copies WITH (security_invoker = true) AS
SELECT c.height, c.pool, c.site, c.replica, c.source_id, c.received_at, c.received_at_offset_s, c.job_id,
       c.prev_hash, c.coinbase1, c.coinbase2, c.merkle_branches, c.version, c.nbits, c.ntime, c.clean_jobs,
       c.extranonce1, c.extranonce2_length, c.latency_ms, c.latency_method, c.chain, c.reason,
       c.is_primary, c.copy_no,
       CASE WHEN c.is_primary THEN 'primary' WHEN c.primary_copy THEN 'copy' WHEN c.primary_has_key THEN 'extra'
            WHEN c.primary_has_job THEN 'near_miss' ELSE 'gap_fill' END AS class,
       CASE WHEN c.is_primary THEN c.copy_first_seen ELSE c.received_at END AS first_seen,
       CASE WHEN c.is_primary THEN c.copy_count ELSE 1 END AS copies,
       CASE WHEN c.is_primary THEN c.copy_replicas ELSE ARRAY[c.replica] END AS copy_replicas,
       CASE WHEN c.is_primary THEN c.copy_sites ELSE ARRAY[c.site] END AS copy_sites,
       CASE WHEN c.is_primary THEN c.copy_times ELSE ARRAY[c.received_at] END AS copy_times,
       c.primary_received_at   -- the matched primary row's own received_at ('primary' and 'copy' rows)
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
           bool_or(o.is_primary)  OVER job_w  AS primary_has_job   -- ... or the same job with another ntime
      FROM (
        SELECT t.*, s.name AS pool, s.site, s.replica,
               ARRAY[s.site, s.replica] = min(ARRAY[s.site, s.replica]) OVER (PARTITION BY t.height, s.name)
                 AS is_primary,
               row_number() OVER (PARTITION BY t.height, s.name, t.source_id, t.chain, t.prev_hash, t.merkle_branches,
                                               t.version, t.nbits, t.ntime
                                  ORDER BY t.received_at, t.job_id, t.coinbase1, t.coinbase2) AS copy_no
          FROM templates_other t JOIN sources s ON s.id = t.source_id
      ) o
    WINDOW copy_w AS (PARTITION BY o.height, o.pool, o.chain, o.prev_hash, o.merkle_branches, o.version, o.nbits, o.ntime, o.copy_no),
           key_w  AS (PARTITION BY o.height, o.pool, o.chain, o.prev_hash, o.merkle_branches, o.version, o.nbits, o.ntime),
           job_w  AS (PARTITION BY o.height, o.pool, o.chain, o.prev_hash, o.merkle_branches, o.version, o.nbits)
  ) c;

CREATE VIEW templates_other_dedup WITH (security_invoker = true) AS
SELECT height, pool, chain, prev_hash, merkle_branches, version, nbits, ntime, first_seen, received_at, copies,
       ARRAY(SELECT DISTINCT r FROM unnest(copy_replicas) r ORDER BY r) AS replicas,
       ARRAY(SELECT DISTINCT x FROM unnest(copy_sites) x ORDER BY x) AS sites,
       (SELECT jsonb_object_agg(u.site, u.first) FROM (SELECT v.site, min(v.t) AS first
          FROM unnest(copy_sites, copy_times) v(site, t) GROUP BY v.site) u) AS site_first_seen,
       is_primary, class, source_id, site, replica, received_at_offset_s, job_id, coinbase1, coinbase2, clean_jobs,
       extranonce1, extranonce2_length, latency_ms, latency_method, reason
  FROM templates_other_copies
 WHERE class <> 'copy';

-- What the de-duplication did, for Bitcoin templates received in [from_ts, to_ts): one row per UTC day (of receive
-- time), pool and site, plus a row with site = NULL for the pool as a whole. Rows are classified over whole heights
-- (every height with a row in the window), so a copy just outside the window still counts as matched.
--   rows / primary_rows / secondary_rows     rows received (at that site)
--   secondary_hidden                         exact copies of a primary row (not shown)
--   secondary_shown = extra_copies + near_misses + gap_fills
--   near_miss_ntime_*                        near misses by |ntime difference| to the closest primary row of the
--                                            same job, in seconds: 1, 2, 3, 4-10, over 10
--   first_seen_gains, gain_ms_p50/p95/max    site = NULL: shown primary rows whose first_seen came from an earlier
--                                            copy, and by how much. Per site: that site's exact copies that arrived
--                                            before the primary row, and by how much (same clock caveat as any
--                                            cross-site timing)
CREATE FUNCTION template_dedup_report(from_ts timestamptz, to_ts timestamptz)
RETURNS TABLE (
    day date, pool text, site text,
    rows bigint, primary_rows bigint, secondary_rows bigint, secondary_hidden bigint, secondary_shown bigint,
    extra_copies bigint, near_misses bigint,
    near_miss_ntime_1s bigint, near_miss_ntime_2s bigint, near_miss_ntime_3s bigint, near_miss_ntime_4_10s bigint,
    near_miss_ntime_over_10s bigint,
    gap_fills bigint,
    first_seen_gains bigint, gain_ms_p50 double precision, gain_ms_p95 double precision, gain_ms_max double precision
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
           CASE WHEN c.class = 'near_miss' THEN least(c.ntime - max(c.ntime) FILTER (WHERE c.is_primary) OVER below,
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
         count(*) FILTER (WHERE x.class = 'copy'),
         count(*) FILTER (WHERE NOT x.is_primary AND x.class <> 'copy'),
         count(*) FILTER (WHERE x.class = 'extra'),
         count(*) FILTER (WHERE x.class = 'near_miss'),
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
         CASE WHEN GROUPING(x.site) = 1 THEN max(x.pool_gain_ms) ELSE max(x.site_gain_ms) END
    FROM x
   WHERE x.received_at >= from_ts AND x.received_at < to_ts
   GROUP BY GROUPING SETS ((1, x.pool, x.site), (1, x.pool))
   ORDER BY 1, 2, 3 NULLS FIRST;
END $$;

GRANT SELECT ON templates_copies, templates_dedup, templates_other_copies, templates_other_dedup
  TO stratum_backend, stratum_web;
REVOKE EXECUTE ON FUNCTION template_dedup_report(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION template_dedup_report(timestamptz, timestamptz) TO stratum_backend, stratum_web;

-- migrate:down
DROP FUNCTION template_dedup_report(timestamptz, timestamptz);
DROP VIEW templates_other_dedup;
DROP VIEW templates_other_copies;
DROP VIEW templates_dedup;
DROP VIEW templates_copies;
