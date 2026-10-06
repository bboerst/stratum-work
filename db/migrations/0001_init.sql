-- db/migrations/0001_init.sql
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE templates (
  ts                 timestamptz NOT NULL,
  ts_ns              bigint      NOT NULL,
  mid                bytea       NOT NULL,
  doc_id             text,
  pool               text        NOT NULL,
  connection_id      text        NOT NULL,
  site               text        NOT NULL,
  mode               text        NOT NULL DEFAULT 'observe',
  account            text,
  endpoint_ip        text,
  height             integer     NOT NULL,
  prev_hash          text        NOT NULL,
  job_id             text        NOT NULL,
  version            text        NOT NULL,
  nbits              text,
  ntime              text,
  clean_jobs         boolean     NOT NULL,
  coinbase1          text        NOT NULL,
  coinbase2          text        NOT NULL,
  extranonce1        text,
  extranonce2_length integer     NOT NULL,
  merkle_branches    text[]      NOT NULL,
  chain_family       text,
  lat_ms             double precision,
  lat_m              text,
  extra              jsonb
);
SELECT create_hypertable('templates', by_range('ts', INTERVAL '1 day'));
CREATE UNIQUE INDEX templates_mid_ts ON templates (mid, ts);
CREATE INDEX templates_height_ts ON templates (height, ts);
CREATE INDEX templates_pool_ts ON templates (pool, ts);
ALTER TABLE templates SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'pool, connection_id',
  timescaledb.compress_orderby = 'ts, mid'
);
SELECT add_compression_policy('templates', INTERVAL '1 day');

CREATE TABLE shares (
  ts               timestamptz NOT NULL,
  mid              bytea       NOT NULL,
  connection_id    text        NOT NULL,
  pool             text        NOT NULL,
  site             text        NOT NULL,
  job_id           text,
  share_difficulty double precision,
  pool_difficulty  double precision,
  accepted         boolean     NOT NULL,
  reject_reason    text,
  response_ms      double precision
);
SELECT create_hypertable('shares', by_range('ts', INTERVAL '1 day'));
CREATE UNIQUE INDEX shares_mid_ts ON shares (mid, ts);
SELECT add_retention_policy('shares', INTERVAL '14 days');

CREATE TABLE routing (
  ts      timestamptz NOT NULL,
  mid     bytea       NOT NULL,
  site    text        NOT NULL,
  status  jsonb       NOT NULL
);
SELECT create_hypertable('routing', by_range('ts', INTERVAL '7 days'));
CREATE UNIQUE INDEX routing_mid_ts ON routing (mid, ts);
SELECT add_retention_policy('routing', INTERVAL '90 days');

CREATE TABLE blocks (
  height              integer PRIMARY KEY,
  block_hash          text    NOT NULL UNIQUE,
  timestamp           bigint  NOT NULL,
  coinbase_script_sig text,
  mining_pool         jsonb,
  analysis            jsonb,
  transactions        integer,
  size                integer,
  weight              integer,
  version             bigint,
  merkle_root         text,
  bits                text,
  nonce               bigint,
  difficulty          double precision
);
CREATE INDEX blocks_analysis_interesting ON blocks (height DESC)
  WHERE analysis IS NOT NULL AND (analysis - 'pool_identification') <> '{}'::jsonb;

CREATE TABLE pools (
  id        serial PRIMARY KEY,
  name      text   NOT NULL,
  tag       text,
  addresses text[] NOT NULL DEFAULT '{}',
  doc       jsonb  NOT NULL
);
