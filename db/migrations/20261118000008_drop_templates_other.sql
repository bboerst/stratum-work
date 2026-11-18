-- migrate:up
-- One templates table, step 4 (docs/design/one-templates-table.md): every template is in `templates` (the collectors
-- stopped classifying in step 2, step 3 moved the old rows; their write-time chain/reason are kept in
-- template_routing_labels). Drop templates_other, its views, its columnstore policy (dropped with the table), its
-- grants (likewise) and the `chain` type. Which chain a template belongs to is judged at read time from stored facts
-- (bitcoin_parents, height windows).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM templates_other) THEN
    RAISE EXCEPTION 'templates_other still has rows: move them into templates first (step 3)';
  END IF;
END $$;
DROP VIEW templates_other_dedup;
DROP VIEW templates_other_copies;
DROP TABLE templates_other;
DROP TYPE chain;
COMMENT ON COLUMN templates.height IS
    'BIP34 height from the coinbase as the pool sent it (0 if it could not be parsed). Not validated: which chain a '
    'template belongs to, and whether it is current, is judged at read time (bitcoin_parents, height_window()).';

-- migrate:down transaction:false
-- An empty templates_other as it was before (20261112000002 core schema, 000003 policy, 000004 grants,
-- 20261116200001 views, verbatim). Outside a transaction for the columnstore policy (a procedure).
COMMENT ON COLUMN templates.height IS NULL;
CREATE TYPE chain AS ENUM ('btc', 'bch', 'unknown');
CREATE TABLE templates_other (LIKE templates INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE templates_other
    ADD COLUMN chain chain NOT NULL,
    ADD COLUMN reason text NOT NULL;  -- e.g. 'bch', 'height_parse_failed', 'height_implausible'
SELECT create_hypertable('templates_other', by_range('received_at', INTERVAL '30 days'));
CREATE INDEX templates_other_height ON templates_other (height, source_id, received_at);
ALTER TABLE templates_other SET (
    timescaledb.enable_columnstore,
    timescaledb.segmentby = 'source_id',
    timescaledb.orderby   = 'height, received_at'
);
CALL add_columnstore_policy('templates_other', after => INTERVAL '2 days');
GRANT INSERT ON templates_other TO stratum_collector;
GRANT SELECT ON templates_other TO stratum_backend, stratum_web;

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

GRANT SELECT ON templates_other_copies, templates_other_dedup TO stratum_backend, stratum_web;
