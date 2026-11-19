-- migrate:up
-- Where a stale block's header came from (#243, follow-up to 20261116100001_stale_blocks.sql).
--
-- Until now every stale_blocks row was recorded from our node (getchaintips, getblockheader, getblock). Blocks from
-- before stale-block tracking, or that lost the race before they reached our node, are proved to exist by the
-- templates pools built on them, but our node never had them. Their headers can come from the public stale-blocks
-- dataset (github.com/bitcoin-data/stale-blocks, CC0), accepted only after the importer's checks (backend/
-- stale_import.py: the header hashes to the block hash, meets its proof of work at the best chain's difficulty there,
-- builds on our best block at height - 1, and pools' templates built on it).
--   header_source  'node'                       recorded from our node (every row before this migration)
--                  'bitcoin-data/stale-blocks'  imported from the dataset (and full_block from its blocks/ files)
-- Such a row's chaintip_status / last_status is 'not-in-node': no getchaintips status of ours applies. If our node
-- later reports the block, the tracker updates last_status as for any row; header_source stays what first recorded it.
ALTER TABLE stale_blocks
    ADD COLUMN header_source text NOT NULL DEFAULT 'node'
        CHECK (header_source IN ('node', 'bitcoin-data/stale-blocks'));
COMMENT ON COLUMN stale_blocks.header_source IS
    'Where the header came from: node (our node''s getchaintips / getblockheader) or bitcoin-data/stale-blocks (the public dataset, imported by backend/stale_import.py after validation)';
ALTER TABLE stale_blocks
    DROP CONSTRAINT stale_blocks_chaintip_status_check,
    DROP CONSTRAINT stale_blocks_last_status_check,
    ADD CONSTRAINT stale_blocks_chaintip_status_check
        CHECK (chaintip_status IN ('valid-fork', 'valid-headers', 'headers-only', 'invalid', 'active', 'not-in-node')),
    ADD CONSTRAINT stale_blocks_last_status_check
        CHECK (last_status IN ('valid-fork', 'valid-headers', 'headers-only', 'invalid', 'active', 'not-in-node'));

-- migrate:down
-- The old CHECKs can't hold imported rows: remove them first (they are re-importable from the dataset).
DELETE FROM stale_blocks WHERE header_source <> 'node' OR chaintip_status = 'not-in-node' OR last_status = 'not-in-node';
ALTER TABLE stale_blocks
    DROP CONSTRAINT stale_blocks_chaintip_status_check,
    DROP CONSTRAINT stale_blocks_last_status_check,
    ADD CONSTRAINT stale_blocks_chaintip_status_check
        CHECK (chaintip_status IN ('valid-fork', 'valid-headers', 'headers-only', 'invalid', 'active')),
    ADD CONSTRAINT stale_blocks_last_status_check
        CHECK (last_status IN ('valid-fork', 'valid-headers', 'headers-only', 'invalid', 'active')),
    DROP COLUMN header_source;
