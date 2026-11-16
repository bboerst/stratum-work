-- migrate:up
-- One stream per pool (replaces the rule of 20261115000001_templates_dedup.sql, which hid exact copies only).
-- Some pools give each connection its own job stream (other merkle branches, or the same job with another ntime),
-- so with two collectors such a pool showed about twice its templates. Now the views show ONE connection's stream
-- per pool, and another connection's rows only while that one had nothing:
--
-- * Source order: a pool's (sources.name) sources are ranked by (site, replica), compared byte-wise (COLLATE "C",
--   the order the live stream uses too; for the lower-case ASCII names in use it's the order #177 used). At each
--   height the lowest-ranked source with rows there is the primary, as before.
-- * Every primary row is shown, exactly as stored (re-sends included). With one source per pool the views return
--   exactly the raw rows.
-- * A secondary row is hidden as 'copy' if it is an EXACT copy of a primary row, matched one-to-one as before (same
--   height, pool, prev_hash, merkle_branches, version, nbits, ntime; no tolerance). first_seen, copies, replicas,
--   sites and site_first_seen of the primary row come from it and its copies, as before.
-- * Otherwise it is hidden as 'secondary_stream' if a LOWER-ranked source of the pool was active at the time: has a
--   row at the same height received in [received_at - template_stream_silence(), received_at +
--   template_stream_lead()]. Only receive times of that source's own rows are used, nothing about template fields.
-- * Otherwise it is shown as 'gap_fill': every lower-ranked source was silent (collector down, connection lost,
--   reconnecting). E.g. replica a is down for five minutes: b's rows from 90 s after a's last row until 10 s before
--   a's next one are shown. With three sources, c's rows are shown only while a and b are both silent.
-- * Nothing is deleted: templates_copies classifies every row. primary_match keeps how a secondary row relates to
--   the primary's rows at that height (#177's classes): 'copy', 'extra' (the primary has that exact template, fewer
--   times), 'near_miss' (the same job with another ntime) or 'other_job' (a job the primary doesn't have).
--
-- Why these windows (named constants, one function each):
--   template_stream_silence() = 90 s  A connection that is up receives a job at least every 30-60 s (pools refresh
--       work on a timer), so a source with no row for longer than that had no data. 90 s covers a 60 s refresh with
--       margin. An outage shorter than this is not filled (the pool's next job supersedes what was missed); a
--       pool that is normally quieter than 90 s between jobs would show a few secondary rows in its quiet gaps
--       (visible in template_dedup_report as gap_fills).
--   template_stream_lead() = 10 s  At a new block every connection gets the new job within milliseconds to a few
--       seconds of each other, in no fixed order. A secondary's row up to 10 s before the lower-ranked source's
--       first row of the height belongs to the same moment, not to an outage.
-- The live stream (web/lib/streamDedup.ts) applies the same rule as it goes: a source's template is forwarded if
-- no lower-ranked source of the pool sent anything in the last 90 s.
--
-- Cost: one more sort of the height's rows (by pool and receive time) for the activity window; filters on height
-- (or a height range, or pool) are still pushed down to the index and the columnstore's height metadata. Always
-- filter on height.

-- Replace the exact-copies-only objects of 20261115000001 (the report's columns change, so drop and create).
DROP FUNCTION template_dedup_report(timestamptz, timestamptz);
DROP VIEW templates_other_dedup;
DROP VIEW templates_other_copies;
DROP VIEW templates_dedup;
DROP VIEW templates_copies;

CREATE FUNCTION template_stream_silence() RETURNS interval LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT interval '90 seconds' $$;
CREATE FUNCTION template_stream_lead() RETURNS interval LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT interval '10 seconds' $$;

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

-- The same over templates_other: chain is part of every copy key; activity is per pool and height, like the primary.
CREATE VIEW templates_other_copies WITH (security_invoker = true) AS
SELECT c.height, c.pool, c.site, c.replica, c.source_id, c.received_at, c.received_at_offset_s, c.job_id,
       c.prev_hash, c.coinbase1, c.coinbase2, c.merkle_branches, c.version, c.nbits, c.ntime, c.clean_jobs,
       c.extranonce1, c.extranonce2_length, c.latency_ms, c.latency_method, c.chain, c.reason,
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
       c.source_rank, c.active_rank
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
               row_number() OVER (PARTITION BY t.height, s.name, t.source_id, t.chain, t.prev_hash, t.merkle_branches,
                                               t.version, t.nbits, t.ntime
                                  ORDER BY t.received_at, t.job_id, t.coinbase1, t.coinbase2) AS copy_no
          FROM templates_other t
          JOIN (SELECT id, name, site, replica,
                       dense_rank() OVER (PARTITION BY name ORDER BY site COLLATE "C", replica COLLATE "C")::integer
                         AS source_rank
                  FROM sources) s ON s.id = t.source_id
      ) o
    WINDOW copy_w AS (PARTITION BY o.height, o.pool, o.chain, o.prev_hash, o.merkle_branches, o.version, o.nbits, o.ntime, o.copy_no),
           key_w  AS (PARTITION BY o.height, o.pool, o.chain, o.prev_hash, o.merkle_branches, o.version, o.nbits, o.ntime),
           job_w  AS (PARTITION BY o.height, o.pool, o.chain, o.prev_hash, o.merkle_branches, o.version, o.nbits),
           active_w AS (PARTITION BY o.height, o.pool ORDER BY o.received_at
                        RANGE BETWEEN template_stream_silence() PRECEDING AND template_stream_lead() FOLLOWING)
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
 WHERE class IN ('primary', 'gap_fill');

-- What the de-duplication did, for Bitcoin templates received in [from_ts, to_ts): one row per UTC day (of receive
-- time), pool and site, plus a row with site = NULL for the pool as a whole. Rows are classified over whole heights
-- (every height with a row in the window), so a copy just outside the window still counts as matched.
--   rows / primary_rows / secondary_rows     rows received (at that site)
--   secondary_hidden = exact_copies + secondary_stream     secondary rows not shown
--   secondary_shown = gap_fills              secondary rows shown because every lower-ranked source was silent
--   exact_copies                             hidden: exact copies of a primary row
--   secondary_stream                         hidden: another connection's stream while a lower-ranked one was active
--   extra_copies, near_misses, near_miss_ntime_*   how the secondary rows that aren't exact copies (hidden or shown)
--                                            relate to the primary's rows (primary_match): more exact copies than
--                                            the primary has; the same job with another ntime, by |ntime difference|
--                                            to the closest primary row of the job in seconds: 1, 2, 3, 4-10, over 10
--   first_seen_gains, gain_ms_p50/p95/max    site = NULL: shown primary rows whose first_seen came from an earlier
--                                            copy, and by how much. Per site: that site's exact copies that arrived
--                                            before the primary row, and by how much (same clock caveat as any
--                                            cross-site timing)
-- exact_copies and secondary_stream are the last two columns, so readers of the previous columns keep working.
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

GRANT SELECT ON templates_copies, templates_dedup, templates_other_copies, templates_other_dedup
  TO stratum_backend, stratum_web;
REVOKE EXECUTE ON FUNCTION template_dedup_report(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION template_dedup_report(timestamptz, timestamptz) TO stratum_backend, stratum_web;

-- migrate:down
-- Back to exact copies only (20261115000001_templates_dedup.sql, verbatim).
DROP FUNCTION template_dedup_report(timestamptz, timestamptz);
DROP VIEW templates_other_dedup;
DROP VIEW templates_other_copies;
DROP VIEW templates_dedup;
DROP VIEW templates_copies;
DROP FUNCTION template_stream_lead();
DROP FUNCTION template_stream_silence();

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

