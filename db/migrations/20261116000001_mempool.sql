-- migrate:up
-- Mempool recorder (stratum-work#180, slice 2; component mempool-recorder/). Every transaction the node's mempool
-- accepted, with first-seen time and how it left, so templates can be resolved against what was in the mempool:
-- a template's merkle_branches[0] is the txid of its first non-coinbase transaction.
--
-- Hashes (txid, wtxid, block hashes) are bytea in INTERNAL byte order: the bytes as hashed, the order used in
-- blocks, merkle trees and Stratum merkle_branches. So `txid = substring(t.merkle_branches from 1 for 32)` matches
-- directly. RPC, ZMQ and explorers DISPLAY hashes reversed: hash_display(txid) gives that hex, and
-- hash_from_display('4a5e1e4b...') the bytea to compare with.

CREATE FUNCTION hash_display(h bytea) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT string_agg(lpad(to_hex(get_byte(h, i)), 2, '0'), '' ORDER BY i DESC) FROM generate_series(0, length(h) - 1) i
$$;
CREATE FUNCTION hash_from_display(s text) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT decode(string_agg(substr(s, 2 * i + 1, 2), '' ORDER BY i DESC), 'hex') FROM generate_series(0, length(s) / 2 - 1) i
$$;

CREATE TYPE mempool_removal AS ENUM ('mined', 'replaced', 'conflict', 'reorg', 'expired', 'evicted', 'unknown');

-- One row per stay in the mempool: a transaction that leaves and is accepted again (after a reorg, or rebroadcast
-- after eviction) gets a new row with its new first_seen.
CREATE TABLE mempool_txs (
    first_seen      timestamptz NOT NULL,  -- receipt of the ZMQ `A` event (UTC, µs); or the node's entry time
    first_seen_src  text        NOT NULL CHECK (first_seen_src IN ('zmq', 'mempool')),
                                           -- 'mempool': already in the mempool at a sync, time from getrawmempool
                                           -- (whole seconds, the node's clock)
    txid            bytea       NOT NULL CHECK (octet_length(txid) = 32),
    wtxid           bytea                CHECK (octet_length(wtxid) = 32),
    size            integer,               -- serialized bytes, with witness
    vsize           integer,               -- BIP141 virtual size, ceil(weight / 4)
    weight          integer,
    fee             bigint,                -- satoshis; NULL if the tx left before getmempoolentry ran
    modified_fee    bigint,                -- with prioritisetransaction deltas (what mining uses)
    ancestor_count  integer,               -- ancestor/descendant stats as of first seen (they change later)
    ancestor_size   integer,               -- sigop-adjusted vsize, incl. this tx
    ancestor_fees   bigint,                -- modified fees, incl. this tx
    descendant_count integer,
    descendant_size  integer,
    descendant_fees  bigint,
    input_count     integer,               -- inputs in mempool_tx_inputs; NULL if unknown (tx never fetched)
    removed_at      timestamptz CHECK (removed_at >= first_seen),
    removal         mempool_removal,
    removed_src     text        CHECK (removed_src IN ('zmq', 'resync')),
                                           -- 'resync': found gone at a sync; removed_at is that time (an upper bound)
    replaced_by     bytea       CHECK (octet_length(replaced_by) = 32),
                                           -- replaced: the replacement; conflict: the block tx spending its input
    block_hash      bytea       CHECK (octet_length(block_hash) = 32),  -- mined / conflict
    block_height    integer,
    CHECK ((removed_at IS NULL) = (removal IS NULL) AND (removed_at IS NULL) = (removed_src IS NULL))
);
SELECT create_hypertable('mempool_txs', by_range('first_seen', INTERVAL '1 day'));

-- txid lookup (a template's merkle_branches[0]); also the row key the recorder updates by. On compressed chunks a
-- bloom filter per batch (sparse_index below) does the same job.
CREATE UNIQUE INDEX mempool_txs_txid ON mempool_txs (txid, first_seen);
-- Mempool snapshot at time t:  tstzrange(first_seen, removed_at) @> t  (uncompressed chunks; see the design doc).
CREATE INDEX mempool_txs_alive ON mempool_txs USING gist (tstzrange(first_seen, removed_at, '[)'));
-- Rows still open: what a restarted recorder reloads.
CREATE INDEX mempool_txs_open ON mempool_txs (first_seen) WHERE removed_at IS NULL;

-- Columnstore after 15 days (policy in the next migration): past the default -mempoolexpiry (14 days), so rows are
-- closed before they're compressed and the recorder's updates never touch compressed data. Batches ordered by
-- removed_at carry tight min/max removed_at, so snapshot queries skip batches that left before t.
ALTER TABLE mempool_txs SET (
    timescaledb.enable_columnstore,
    timescaledb.segmentby    = '',
    timescaledb.orderby      = 'removed_at, first_seen',
    timescaledb.sparse_index = 'bloom(txid)'
);

-- Transaction inputs (prevouts), one row per input, keyed like mempool_txs by (txid, first_seen). Kept for 30 DAYS
-- only (retention policy in the next migration): the recorder needs them only while a tx is in the mempool (at
-- most -mempoolexpiry, 14 days; reloaded from here after a restart) to detect replacements and conflicts. So the
-- resolver (and any analysis of spends: CPFP, conflict chains) has inputs for the last 30 days only; older
-- mempool_txs rows keep input_count but not the inputs. Inputs are the largest incompressible part of a row
-- (32-byte prevout hashes), which is why they aren't kept forever.
CREATE TABLE mempool_tx_inputs (
    first_seen   timestamptz NOT NULL,   -- the mempool_txs row's first_seen (time column)
    txid         bytea       NOT NULL CHECK (octet_length(txid) = 32),
    n            integer     NOT NULL CHECK (n >= 0),               -- input index
    prevout_txid bytea       NOT NULL CHECK (octet_length(prevout_txid) = 32),  -- internal byte order
    prevout_vout bigint      NOT NULL CHECK (prevout_vout BETWEEN 0 AND 4294967295)  -- u32
);
SELECT create_hypertable('mempool_tx_inputs', by_range('first_seen', INTERVAL '1 day'));
CREATE UNIQUE INDEX mempool_tx_inputs_tx ON mempool_tx_inputs (txid, first_seen, n);
-- Columnstore after 2 days, like templates: rows never change. Ordered by first_seen (a tx's inputs share it, so they
-- sit together), bloom filters on both hashes. The restart reload joins open rows to their inputs: measured 72 ms for
-- 20k open transactions with both tables compressed.
ALTER TABLE mempool_tx_inputs SET (timescaledb.enable_columnstore, timescaledb.segmentby = '',
    timescaledb.orderby = 'first_seen, n', timescaledb.sparse_index = 'bloom(txid), bloom(prevout_txid)');

-- Raw transactions, only when the recorder runs with --store-raw (default off; ~300 MB/day on mainnet). Separate
-- table so a retention window can drop whole chunks without touching the metadata.
CREATE TABLE mempool_tx_raw (
    first_seen timestamptz NOT NULL,
    txid       bytea       NOT NULL CHECK (octet_length(txid) = 32),
    raw        bytea       NOT NULL
);
SELECT create_hypertable('mempool_tx_raw', by_range('first_seen', INTERVAL '1 day'));
CREATE INDEX mempool_tx_raw_txid ON mempool_tx_raw (txid, first_seen);
ALTER TABLE mempool_tx_raw SET (timescaledb.enable_columnstore, timescaledb.segmentby = '',
    timescaledb.orderby = 'first_seen', timescaledb.sparse_index = 'bloom(txid)');

-- Block connects and disconnects as the recorder saw them on the `sequence` feed.
CREATE TABLE mempool_blocks (
    seen_at             timestamptz NOT NULL,
    block_hash          bytea       NOT NULL CHECK (octet_length(block_hash) = 32),
    height              integer,
    event               text        NOT NULL CHECK (event IN ('connect', 'disconnect')),
    tx_count            integer,               -- incl. the coinbase
    from_mempool        integer,               -- transactions that left our mempool as mined
    off_mempool         integer,               -- rows written to mempool_offmempool
    off_mempool_checked boolean     NOT NULL DEFAULT false
                                               -- false: not synced when it connected (startup / resync), so the
                                               -- block's other transactions aren't recorded as off-mempool
);
CREATE INDEX mempool_blocks_seen ON mempool_blocks (seen_at);
CREATE INDEX mempool_blocks_hash ON mempool_blocks (block_hash);

-- Block transactions that were never in our mempool (no mempool_txs row within the recorder's lookback when the
-- block connected): out-of-band / accelerated / private transactions, or ones our node simply never received.
-- The coinbase is never listed.
CREATE TABLE mempool_offmempool (
    block_hash bytea       NOT NULL CHECK (octet_length(block_hash) = 32),
    height     integer,
    seen_at    timestamptz NOT NULL,  -- when the block connected
    txid       bytea       NOT NULL CHECK (octet_length(txid) = 32),
    position   integer     NOT NULL,  -- index in the block (1 = first after the coinbase)
    PRIMARY KEY (block_hash, txid)
);
CREATE INDEX mempool_offmempool_txid ON mempool_offmempool (txid);
CREATE INDEX mempool_offmempool_seen ON mempool_offmempool (seen_at);

-- Least privilege: the recorder writes its own tables and nothing else. SELECT on mempool_txs is needed for the
-- UPDATE ... WHERE that closes a row, the restart reload and the off-mempool check (and on mempool_tx_inputs for the
-- reload); on mempool_blocks for the
-- last-block lookup at restart.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'stratum_mempool') THEN CREATE ROLE stratum_mempool NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO stratum_mempool;
GRANT SELECT, INSERT, UPDATE ON mempool_txs TO stratum_mempool;
GRANT SELECT, INSERT ON mempool_tx_inputs TO stratum_mempool;  -- SELECT: the restart reload
GRANT INSERT ON mempool_tx_raw, mempool_offmempool TO stratum_mempool;
GRANT SELECT, INSERT ON mempool_blocks TO stratum_mempool;
GRANT SELECT ON mempool_txs, mempool_tx_inputs, mempool_tx_raw, mempool_blocks, mempool_offmempool TO stratum_backend, stratum_web;

-- migrate:down
REVOKE ALL ON mempool_txs, mempool_tx_inputs, mempool_tx_raw, mempool_blocks, mempool_offmempool FROM stratum_mempool, stratum_backend, stratum_web;
REVOKE USAGE ON SCHEMA public FROM stratum_mempool;
DROP TABLE mempool_offmempool;
DROP TABLE mempool_blocks;
DROP TABLE mempool_tx_raw;
DROP TABLE mempool_tx_inputs;
DROP TABLE mempool_txs;
DROP TYPE mempool_removal;
DROP FUNCTION hash_from_display(text);
DROP FUNCTION hash_display(bytea);
DROP ROLE IF EXISTS stratum_mempool;
