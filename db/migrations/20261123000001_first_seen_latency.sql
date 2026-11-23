-- migrate:up
-- The latency estimate of the copy that set first_seen. templates_dedup() shows a template at first_seen, the earliest
-- exact copy over the pool's connections (possibly another replica's or site's), but its latency_ms / latency_method
-- are the shown row's own: with latency adjustment on, a reader subtracted one connection's RTT/2 from another
-- connection's receive time. first_seen_latency_ms / first_seen_latency_method are the estimate and method of the copy
-- whose receive time is first_seen (on an equal receive time, the lower-ranked source's), so first_seen is adjusted
-- with the estimate measured on the same connection. NULL when that copy has no estimate, never another connection's.
-- latency_ms / latency_method stay the row's own.
--
-- Otherwise 20261118000006's bodies, unchanged: LANGUAGE sql, STABLE, one statement, not STRICT, so both are still
-- inlined and the bounds reach chunk exclusion. The new columns are appended (readers selecting the old ones by name
-- keep working). A new result type needs DROP + CREATE; the grants are restored as 20261118000006 set them.
DROP FUNCTION templates_dedup(integer, integer, timestamptz, timestamptz);
DROP FUNCTION templates_copies(integer, integer, timestamptz, timestamptz);

CREATE FUNCTION templates_copies(h_from integer, h_to integer, t_from timestamptz, t_to timestamptz)
RETURNS TABLE (
    height integer, pool text, site text, replica text, source_id smallint, received_at timestamptz,
    received_at_offset_s integer, job_id text, prev_hash bytea, coinbase1 bytea, coinbase2 bytea,
    merkle_branches bytea, version bigint, nbits bigint, ntime bigint, clean_jobs boolean, extranonce1 bytea,
    extranonce2_length smallint, latency_ms real, latency_method latency_method, is_primary boolean, copy_no bigint,
    class text, first_seen timestamptz, copies bigint, copy_replicas text[], copy_sites text[],
    copy_times timestamptz[], primary_received_at timestamptz, primary_match text, source_rank integer,
    active_rank integer, first_seen_latency_ms real, first_seen_latency_method latency_method
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
       c.active_rank,          -- the lowest-ranked source with a row in the activity window around this row
       -- the latency estimate of the connection whose copy set first_seen (the same CASE as first_seen)
       CASE WHEN c.is_primary THEN c.copy_first_latency_ms ELSE c.latency_ms END AS first_seen_latency_ms,
       CASE WHEN c.is_primary THEN c.copy_first_latency_method ELSE c.latency_method END AS first_seen_latency_method
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
           min(o.source_rank)     OVER active_w AS active_rank,
           first_value(o.latency_ms)     OVER copy_first_w AS copy_first_latency_ms,     -- the earliest copy's own
           first_value(o.latency_method) OVER copy_first_w AS copy_first_latency_method  -- estimate and method
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
                        RANGE BETWEEN template_stream_silence() PRECEDING AND template_stream_lead() FOLLOWING),
           -- the copies in receive order (min(received_at) OVER copy_w is the first); on an equal receive time the
           -- lower-ranked source, the primary, comes first
           copy_first_w AS (copy_w ORDER BY o.received_at, o.source_rank)
  ) c
$$;

CREATE FUNCTION templates_dedup(h_from integer, h_to integer, t_from timestamptz, t_to timestamptz)
RETURNS TABLE (
    height integer, pool text, prev_hash bytea, merkle_branches bytea, version bigint, nbits bigint, ntime bigint,
    first_seen timestamptz, received_at timestamptz, copies bigint, replicas text[], sites text[],
    site_first_seen jsonb, is_primary boolean, class text, source_id smallint, site text, replica text,
    received_at_offset_s integer, job_id text, coinbase1 bytea, coinbase2 bytea, clean_jobs boolean,
    extranonce1 bytea, extranonce2_length smallint, latency_ms real, latency_method latency_method,
    first_seen_latency_ms real, first_seen_latency_method latency_method
)
LANGUAGE sql STABLE AS $$
SELECT height, pool, prev_hash, merkle_branches, version, nbits, ntime, first_seen, received_at, copies,
       ARRAY(SELECT DISTINCT r FROM unnest(copy_replicas) r ORDER BY r) AS replicas,
       ARRAY(SELECT DISTINCT x FROM unnest(copy_sites) x ORDER BY x) AS sites,
       (SELECT jsonb_object_agg(u.site, u.first) FROM (SELECT v.site, min(v.t) AS first
          FROM unnest(copy_sites, copy_times) v(site, t) GROUP BY v.site) u) AS site_first_seen,
       is_primary, class, source_id, site, replica, received_at_offset_s, job_id, coinbase1, coinbase2, clean_jobs,
       extranonce1, extranonce2_length, latency_ms, latency_method, first_seen_latency_ms, first_seen_latency_method
  FROM templates_copies(h_from, h_to, t_from, t_to)
 WHERE class IN ('primary', 'gap_fill')
$$;

REVOKE EXECUTE ON FUNCTION templates_copies(integer, integer, timestamptz, timestamptz),
    templates_dedup(integer, integer, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION templates_copies(integer, integer, timestamptz, timestamptz),
    templates_dedup(integer, integer, timestamptz, timestamptz) TO stratum_backend, stratum_web;

-- migrate:down
-- 20261118000006's functions, without the new columns, and their grants.
DROP FUNCTION templates_dedup(integer, integer, timestamptz, timestamptz);
DROP FUNCTION templates_copies(integer, integer, timestamptz, timestamptz);

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

REVOKE EXECUTE ON FUNCTION templates_copies(integer, integer, timestamptz, timestamptz),
    templates_dedup(integer, integer, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION templates_copies(integer, integer, timestamptz, timestamptz),
    templates_dedup(integer, integer, timestamptz, timestamptz) TO stratum_backend, stratum_web;
