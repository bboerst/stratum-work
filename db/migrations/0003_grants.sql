-- db/migrations/0003_grants.sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ingest') THEN
    GRANT SELECT, INSERT ON templates, shares, routing TO ingest;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'web') THEN
    GRANT SELECT ON templates, shares, routing, blocks, pools, shares_minutely TO web;
    -- Tables created later by the migrating role are readable by web without per-migration grants.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backend') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON blocks, pools TO backend;
    GRANT SELECT ON templates TO backend;
    GRANT USAGE ON SEQUENCE pools_id_seq TO backend;
  END IF;
END $$;
