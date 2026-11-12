-- migrate:up
-- TimescaleDB must be in shared_preload_libraries (CNPG: postgresql.shared_preload_libraries; local: compose command).
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- migrate:down
DROP EXTENSION IF EXISTS timescaledb;
