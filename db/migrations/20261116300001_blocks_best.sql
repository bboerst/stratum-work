-- migrate:up
-- Blocks on the best chain (#194, follow-up to 20261116100001_stale_blocks.sql).
--
-- blocks keeps every block the backend stored, including ones a reorg later disconnected: it is keyed by hash, so the
-- losing and the winning block at a height coexist. The backend records a block that is no longer on our node's
-- active chain in stale_blocks, and sets stale_blocks.reorged_in_at when a later reorg makes it active again (and
-- back to NULL if it goes stale once more). So a blocks row is currently stale exactly when it has a stale_blocks row
-- with reorged_in_at IS NULL, the same predicate stale_tip_templates() uses for "the best block at height - 1".
--
-- blocks_best: blocks without the currently stale ones. Reads that mean "the block at height h", "recent blocks" or
-- "the tip" go through it; lookups by hash keep reading blocks (a stale block is still found, and can be flagged).
-- Blocks never recorded in stale_blocks are all shown, so with no stale_blocks rows (or in a database the stale-block
-- tracker never ran on) this is exactly blocks.
--
-- A plain view (inlined by the planner): the anti-join probes stale_blocks' primary key (or hashes the small table),
-- so the height reads still walk blocks_height / blocks_interesting and stop at their LIMIT.
-- security_invoker: a reader needs SELECT on blocks and stale_blocks itself (the view grants nothing extra).
CREATE VIEW blocks_best WITH (security_invoker = true) AS
SELECT b.*
  FROM blocks b
 WHERE NOT EXISTS (SELECT 1 FROM stale_blocks s WHERE s.block_hash = b.block_hash AND s.reorged_in_at IS NULL);

GRANT SELECT ON blocks_best TO stratum_backend, stratum_web;

-- migrate:down
DROP VIEW blocks_best;
