-- migrate:up
-- Stale (orphaned) blocks and templates built on a stale tip (#180, slice 3).
--
-- The backend polls the node's getchaintips (on every new block and on a timer) and records every block of a
-- non-active branch near the tip: always its header (getblockheader), and the full block when the node downloaded it
-- (getblock; 'valid-fork' tips, sometimes others). A reorg (our active chain switches) turns the previously active
-- blocks into a non-active branch, so they are recorded the same way, with was_active = true and a chain_reorgs row.
--
-- Byte order: block_hash, prev_hash and merkle_root are stored like blocks.block_hash, i.e. the RPC / explorer
-- ("display") byte order, decoded from bitcoind's hex. templates.prev_hash is stratum's order: the same 32 bytes as
-- eight 4-byte words in reverse word order (bytes inside a word unchanged). stratum_prev_hash_to_block_hash()
-- converts one to the other.

-- A switch of our node's active chain: depth blocks were disconnected (old_tip back to the fork point at fork_height)
-- and replaced by the branch ending at new_tip. detected_at is when the backend noticed it (within one poll).
CREATE TABLE chain_reorgs (
    id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    detected_at    timestamptz NOT NULL DEFAULT now(),
    fork_height    integer     NOT NULL,   -- height of the last common block
    depth          integer     NOT NULL CHECK (depth > 0),   -- previously active blocks disconnected
    old_tip_hash   bytea       NOT NULL,
    old_tip_height integer     NOT NULL,
    new_tip_hash   bytea       NOT NULL,
    new_tip_height integer     NOT NULL
);
CREATE INDEX chain_reorgs_detected ON chain_reorgs (detected_at DESC);
CREATE INDEX chain_reorgs_old_tip ON chain_reorgs (old_tip_hash);

CREATE TABLE stale_blocks (
    block_hash          bytea       PRIMARY KEY,
    height              integer     NOT NULL,
    prev_hash           bytea       NOT NULL,
    -- header (getblockheader)
    version             bigint      NOT NULL,
    block_time          timestamptz NOT NULL,   -- header time
    bits                bigint      NOT NULL,
    nonce               bigint      NOT NULL,
    merkle_root         bytea       NOT NULL,
    -- what the node said about the branch
    chaintip_status     text        NOT NULL    -- getchaintips status of its branch when first recorded
                        CHECK (chaintip_status IN ('valid-fork', 'valid-headers', 'headers-only', 'invalid', 'active')),
    last_status         text        NOT NULL    -- ... and the latest one ('active': a later reorg made it win)
                        CHECK (last_status IN ('valid-fork', 'valid-headers', 'headers-only', 'invalid', 'active')),
    tip_hash            bytea       NOT NULL,   -- the branch's tip when first recorded
    fork_height         integer     NOT NULL,   -- height of the branch's last block in common with the active chain
    first_seen          timestamptz NOT NULL DEFAULT now(),  -- first seen as a non-active block
    was_active          boolean     NOT NULL DEFAULT false,  -- it was on our active chain until a reorg
    reorg_id            bigint      REFERENCES chain_reorgs (id),
    reorged_in_at       timestamptz,            -- became part of the active chain again (a later reorg); NULL = stale
    -- full block (getblock verbosity 2), when the node has it
    full_block          boolean     NOT NULL DEFAULT false,
    block_fetched_at    timestamptz,
    coinbase_script_sig bytea,
    coinbase_outputs    jsonb,                  -- [{value_sat, script_pubkey (hex), address}], in output order
    tx_count            integer,
    size                integer,
    weight              integer,
    pool_id             integer,                -- pools.id at identification time (no FK: the pool list changes)
    mining_pool         jsonb                   -- identification snapshot, like blocks.mining_pool
);
CREATE INDEX stale_blocks_height ON stale_blocks (height DESC);
-- The stale-tip read joins templates' prev_hash (converted) to a block at height - 1: the primary key serves it.

-- stratum prev_hash (templates.prev_hash) -> block hash in display order (blocks.block_hash, stale_blocks.block_hash).
-- The conversion is its own inverse. NULL unless the input is 32 bytes.
CREATE FUNCTION stratum_prev_hash_to_block_hash(prev bytea) RETURNS bytea
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN length(prev) = 32 THEN
    substring(prev FROM 29 FOR 4) || substring(prev FROM 25 FOR 4) || substring(prev FROM 21 FOR 4) ||
    substring(prev FROM 17 FOR 4) || substring(prev FROM 13 FOR 4) || substring(prev FROM 9 FOR 4) ||
    substring(prev FROM 5 FOR 4) || substring(prev FROM 1 FOR 4) END
$$;

-- Templates built on a tip other than the best chain's block at height - 1, per height, pool and prev_hash, for a
-- height range (always give one: the read goes through the templates height index / columnstore height metadata).
--   tip = 'stale'    prev_hash is a recorded stale block (stale_block_hash, with its height, pool, reorg)
--         'unknown'  prev_hash is neither the best block at height - 1 nor a recorded stale block (a tip the node
--                    never heard of, e.g. a block that lost the race before it reached us)
-- Heights whose best block at height - 1 isn't in blocks are only reported for recorded stale blocks: without the
-- best block there is nothing to compare an unknown prev_hash with. The best block at height - 1 is the blocks row
-- there that isn't currently stale (stale_blocks.reorged_in_at IS NULL); blocks keeps reorged-out blocks too.
-- Template counts come from templates_dedup (exact copies from secondary replicas hidden); first_template_at is the
-- earliest first_seen, last_template_at the latest receive time, both over that pool's templates on that prev_hash.
-- node_switch_at: when our node moved past this tip: the reorg's detection time if our node had it as its tip,
-- otherwise when the backend saw the best block at height - 1 (blocks.seen_at). mined_after_switch =
-- last_template_at - node_switch_at (negative: the pool had moved on before our node had the winning block).
-- templates holds Bitcoin templates only (other chains go to templates_other), so no chain filter is needed.
CREATE FUNCTION stale_tip_templates(from_height integer, to_height integer)
RETURNS TABLE (
    height integer, pool text, prev_hash bytea, prev_block_hash bytea, tip text,
    stale_block_hash bytea, stale_height integer, stale_full_block boolean, stale_mining_pool jsonb,
    stale_was_active boolean, reorg_id bigint, best_block_hash bytea,
    templates bigint, first_template_at timestamptz, last_template_at timestamptz,
    node_switch_at timestamptz, mined_after_switch interval
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH g AS (
    SELECT d.height, d.pool, d.prev_hash, stratum_prev_hash_to_block_hash(d.prev_hash) AS prev_block_hash,
           count(*) AS n, min(d.first_seen) AS first_at, max(d.received_at) AS last_at
      FROM templates_dedup d
     WHERE d.height BETWEEN from_height AND to_height
     GROUP BY d.height, d.pool, d.prev_hash
  ), best AS (
    SELECT b.height, b.block_hash, b.seen_at
      FROM blocks b
     WHERE b.height BETWEEN from_height - 1 AND to_height - 1
       AND NOT EXISTS (SELECT 1 FROM stale_blocks x WHERE x.block_hash = b.block_hash AND x.reorged_in_at IS NULL)
  ), c AS (
    SELECT g.*,
           EXISTS (SELECT 1 FROM best WHERE best.height = g.height - 1 AND best.block_hash = g.prev_block_hash) AS on_best,
           (SELECT best.block_hash FROM best WHERE best.height = g.height - 1
             ORDER BY best.seen_at NULLS LAST, best.block_hash LIMIT 1) AS best_hash,
           (SELECT best.seen_at FROM best WHERE best.height = g.height - 1
             ORDER BY best.seen_at NULLS LAST, best.block_hash LIMIT 1) AS best_seen_at
      FROM g
  )
  SELECT c.height, c.pool, c.prev_hash, c.prev_block_hash,
         CASE WHEN s.block_hash IS NOT NULL THEN 'stale' ELSE 'unknown' END,
         s.block_hash, s.height, s.full_block, s.mining_pool, s.was_active, s.reorg_id, c.best_hash,
         c.n, c.first_at, c.last_at,
         COALESCE(r.detected_at, c.best_seen_at),
         c.last_at - COALESCE(r.detected_at, c.best_seen_at)
    FROM c
    LEFT JOIN stale_blocks s ON s.block_hash = c.prev_block_hash AND s.reorged_in_at IS NULL
    LEFT JOIN chain_reorgs r ON r.id = s.reorg_id
   WHERE NOT c.on_best
     AND (s.block_hash IS NOT NULL OR c.best_hash IS NOT NULL)
   ORDER BY c.height DESC, c.first_at, c.pool
$$;

GRANT SELECT, INSERT, UPDATE ON stale_blocks, chain_reorgs TO stratum_backend;
GRANT USAGE ON SEQUENCE chain_reorgs_id_seq TO stratum_backend;
GRANT SELECT ON stale_blocks, chain_reorgs TO stratum_web;
REVOKE EXECUTE ON FUNCTION stale_tip_templates(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION stale_tip_templates(integer, integer) TO stratum_backend, stratum_web;

-- migrate:down
DROP FUNCTION stale_tip_templates(integer, integer);
DROP FUNCTION stratum_prev_hash_to_block_hash(bytea);
DROP TABLE stale_blocks;
DROP TABLE chain_reorgs;
