-- migrate:up
-- Clock measurements of the machines that stamp the data (collector nodes: templates.received_at; the backend and
-- mempool recorder's node: blocks.seen_at, mempool times), kept with the data instead of only in Prometheus (days of
-- retention). One row per chrony_exporter sample (chrony's tracking report), as scraped: sampled_at is the scrape
-- time. A copier outside this repo writes them (role stratum_clock, INSERT only, ON CONFLICT DO NOTHING, so re-reads of
-- the same window are harmless).
--
-- Raw components only, as chrony reports them; judgements are derived at read time. chrony's worst-case error of
-- the clock at sampled_at: abs(system_time_s) + root_dispersion_s + root_delay_s / 2. A template's node is the node
-- of its source's latest ingest_events "start" at or before received_at; its clock bound is the nearest sample of
-- that node. No sample near a time = unknown, never zero.
CREATE TABLE clock_samples (
    node              text             NOT NULL,  -- the machine (Kubernetes node name, as in ingest_events start rows)
    sampled_at        timestamptz      NOT NULL,
    system_time_s     double precision NOT NULL,  -- chrony's current offset of the system clock from NTP time (chronyc "System time"; sign as chrony reports it)
    last_offset_s     double precision,           -- offset measured at the last clock update
    root_delay_s      double precision NOT NULL,  -- total round-trip delay to the stratum-1 reference
    root_dispersion_s double precision NOT NULL,  -- total dispersion accumulated to the reference
    stratum           smallint,
    reference         text,                       -- the source chrony was synchronised to (address), if reported
    PRIMARY KEY (node, sampled_at)
);
SELECT create_hypertable('clock_samples', by_range('sampled_at', INTERVAL '7 days'));
ALTER TABLE clock_samples SET (timescaledb.enable_columnstore, timescaledb.segmentby = 'node',
                               timescaledb.orderby = 'sampled_at');

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'stratum_clock') THEN CREATE ROLE stratum_clock NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO stratum_clock;
GRANT INSERT ON clock_samples TO stratum_clock;
GRANT SELECT ON clock_samples TO stratum_backend, stratum_web;

-- migrate:down
REVOKE ALL ON clock_samples FROM stratum_clock, stratum_backend, stratum_web;
REVOKE USAGE ON SCHEMA public FROM stratum_clock;
DROP TABLE IF EXISTS clock_samples;
DROP ROLE IF EXISTS stratum_clock;
