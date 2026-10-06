-- no-transaction
-- db/migrations/0002_shares_minutely.sql
CREATE MATERIALIZED VIEW IF NOT EXISTS shares_minutely
WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 minute', ts) AS bucket,
       connection_id, pool, site,
       count(*)                                   AS submitted,
       count(*) FILTER (WHERE accepted)           AS accepted,
       count(*) FILTER (WHERE NOT accepted)       AS rejected,
       coalesce(sum(pool_difficulty) FILTER (WHERE accepted), 0) AS accepted_difficulty
FROM shares
GROUP BY bucket, connection_id, pool, site
WITH NO DATA;
SELECT add_continuous_aggregate_policy('shares_minutely',
  start_offset => INTERVAL '2 hours', end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute', if_not_exists => true);
