-- Candidate schema for stratum.work on Postgres 18 + TimescaleDB 2.30 (design: docs/design/postgres-timescale.md).
-- Merkle branches are stored inline (candidate A). Measured in design doc section 3: a deduplicated branch-set table
-- (candidate B) was larger overall, because consecutive templates rarely share a branch set (1.47 templates/set).

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Server setting, needed by enable_chunk_skipping() below AND by the planner at query time. In production set it in
-- the Postgres config (CloudNativePG: spec.postgresql.parameters); here it is per-database for local dev.
DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET timescaledb.enable_chunk_skipping = on', current_database()); END $$;
SET timescaledb.enable_chunk_skipping = on;

-- Which chain a template is for. Decided at ingest; 'btc' rows live in templates, everything else in
-- templates_other, so Bitcoin queries never need a chain filter.
CREATE TYPE chain AS ENUM ('btc', 'bch', 'unknown');
CREATE TYPE latency_method AS ENUM ('tcp', 'app');

-- One row per collector endpoint (today's mining_notify.pool_name) per collection site. Collectors upsert themselves at
-- startup. `site` = where the collector runs; timing/latency are only comparable within a site (design doc section 5).
CREATE TABLE sources (
    id            smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name          text NOT NULL,
    site          text NOT NULL,
    stratum_url   text,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (name, site)
);

-- Bitcoin block templates (mining.notify), one row per notification.
-- Stored losslessly: hex fields as bytea (half the size), hex integers as bigint. Re-encoding gives back what
-- the pool sent (section 3 verifies that no prod values are upper-case or odd-length hex).
CREATE TABLE templates (
    received_at        timestamptz NOT NULL,  -- collector receive time, UTC (µs)
    received_at_offset_s integer   NOT NULL DEFAULT 0,  -- seconds the migration subtracted for a detected timezone
                                                        -- shift (section 5); 0 for nearly all rows and all new rows
    source_id          smallint    NOT NULL REFERENCES sources (id),
    height             integer     NOT NULL,  -- BIP34 height from the coinbase, validated against our tip
    job_id             text        NOT NULL,
    prev_hash          bytea       NOT NULL,  -- 32 bytes, in stratum's word order exactly as received
    coinbase1          bytea       NOT NULL,
    coinbase2          bytea       NOT NULL,
    merkle_branches    bytea       NOT NULL,  -- n x 32 bytes, concatenated in stratum order
    version            bigint      NOT NULL,  -- hex u32 -> bigint (no sign or 2038 surprises)
    nbits              bigint      NOT NULL,
    ntime              bigint      NOT NULL,
    clean_jobs         boolean     NOT NULL,
    extranonce1        bytea       NOT NULL,
    extranonce2_length smallint    NOT NULL,
    latency_ms         real,
    latency_method     latency_method
);
SELECT create_hypertable('templates', by_range('received_at', INTERVAL '7 days'));

-- Every current read is "templates at height h" (optionally per source, earliest first).
CREATE INDEX templates_height_source_time ON templates (height, source_id, received_at);
-- No surrogate id: Mongo's random UUIDs would cost ~16 incompressible bytes/row (~2 GB at 136M rows), and a unique
-- index on compressed chunks forces decompression on every insert. The migration de-duplicates on
-- (source_id, received_at, job_id) instead.

-- Columnstore: one segment per source, rows ordered by height then time. Consecutive templates from one
-- pool share most bytes (prev_hash, version, nbits, usually merkle_branches), which this layout compresses.
ALTER TABLE templates SET (
    timescaledb.enable_columnstore,
    timescaledb.segmentby = 'source_id',
    timescaledb.orderby   = 'height, received_at'
);
-- Track min/max height per chunk, so height lookups skip non-matching chunks even though partitioning is by time.
SELECT enable_chunk_skipping('templates', 'height');
CALL add_columnstore_policy('templates', after => INTERVAL '2 days');

-- Templates that aren't Bitcoin's, or whose height can't be trusted (other chains on the same endpoints, BIP34
-- parse failures). Same shape plus the classification and the reported height. Expected to be small.
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

-- (Candidate B's merkle_branch_sets table was dropped after measurement; cross-pool branch-set equality is computed
-- on demand, e.g. GROUP BY merkle_branches at a height, ~9 ms. An analytics table can be added later if #94 needs one.)

-- Mining pool identities (mempool/mining-pools pools-v2.json, refreshed daily: upsert, then delete missing).
CREATE TABLE pools (
    id         integer PRIMARY KEY,   -- mining-pools id
    name       text    NOT NULL,
    slug       text,
    link       text,
    tags       text[]  NOT NULL DEFAULT '{}',
    addresses  text[]  NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pools_addresses ON pools USING gin (addresses);

-- Bitcoin blocks, from bitcoind via the backend. Keyed by hash so stale/fork blocks at the same height can coexist.
CREATE TABLE blocks (
    block_hash          bytea       PRIMARY KEY,
    height              integer     NOT NULL,
    block_time          timestamptz NOT NULL,   -- header time
    seen_at             timestamptz,            -- when our backend first saw it (new: enables block-arrival timing)
    coinbase_script_sig bytea       NOT NULL,
    pool_id             integer,                -- pools.id at identification time (no FK: the pool list changes)
    mining_pool         jsonb,                  -- identification snapshot, as today
    analysis            jsonb       NOT NULL DEFAULT '{}',
    tx_count integer, size integer, weight integer, version bigint, merkle_root bytea, bits bigint, nonce bigint,
    difficulty double precision
);
CREATE INDEX blocks_height ON blocks (height DESC);
-- R3 "interesting blocks": any analysis result other than pool identification.
CREATE INDEX blocks_interesting ON blocks (height DESC) WHERE (analysis - 'pool_identification') <> '{}'::jsonb;
