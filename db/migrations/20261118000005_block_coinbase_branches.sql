-- migrate:up
-- Facts that link a block to the Stratum job it was built from (stratum-work#235). Written by the backend when it
-- stores a block (getblock), self-checked before they're stored (backend/coinbase.py): the branches must fold the
-- coinbase txid to the block's merkle root, and the witness-stripped coinbase must hash to its txid.
--   merkle_branches : the coinbase's merkle path (siblings, Stratum order, 32 bytes each, INTERNAL byte order): the
--                     same shape as templates.merkle_branches. Equal => the template carried exactly the block's
--                     transaction set; the first k equal => the first 2^k - 1 transactions after the coinbase match.
--   coinbase_txid   : INTERNAL byte order (the bytes as hashed; RPC displays it reversed).
--   coinbase_tx     : the coinbase transaction, witness stripped (what coinbase1 + extranonce1 + extranonce2 +
--                     coinbase2 make up). New blocks only: older ones are filled from getblock verbosity 1 (txids),
--                     which gives the branches and txid but not the coinbase bytes.
ALTER TABLE blocks ADD COLUMN merkle_branches bytea CHECK (length(merkle_branches) % 32 = 0),
                   ADD COLUMN coinbase_txid   bytea CHECK (length(coinbase_txid) = 32),
                   ADD COLUMN coinbase_tx     bytea;

-- blocks_best (20261116300001) is `SELECT b.*`, which Postgres expands when the view is created, so it doesn't show
-- columns added later (this migration's, and blocks.seen_via from 20261118000001). Re-create it with the same
-- definition; CREATE OR REPLACE may add columns at the end. Same grants.
CREATE OR REPLACE VIEW blocks_best WITH (security_invoker = true) AS
SELECT b.*
  FROM blocks b
 WHERE NOT EXISTS (SELECT 1 FROM stale_blocks s WHERE s.block_hash = b.block_hash AND s.reorged_in_at IS NULL);

-- Which stored templates were these blocks built from, and how closely? Judged at read time from the facts above and
-- the stored templates. One row per (block, source, merkle_branches) with match_depth >= 1 (at least the first
-- transaction after the coinbase agrees):
--   full_match       : every branch equal and the same count => exactly the block's transaction set (verified). With
--                      0 branches (an empty block) every empty template matches: proves nothing (branches = 0).
--   match_depth      : leading branches that agree; the first 2^match_depth - 1 transactions are identical.
--   coinbase_prefix / coinbase_suffix : the block's coinbase starts with the template's coinbase1 / ends with its
--                      coinbase2 (NULL when the block's coinbase bytes aren't stored).
--   coinbase_layout  : the bytes between them are exactly the template's extranonce1 length + extranonce2_length:
--                      the coinbase has this template pool's layout even where per-connection bytes differ.
-- A matching transaction set identifies the job's transactions, not who mined it (unrelated pools can send the same
-- set); block_pool is the block's own identification, to compare. Template reads are bounded by height and by
-- received_at (from the blocks' times), with literals, so TimescaleDB excludes chunks.
CREATE FUNCTION block_template_matches(h_from integer, h_to integer)
RETURNS TABLE (height integer, block_hash text, block_pool text, source_id smallint, pool text, site text, replica text,
               job_id text, first_received timestamptz, n_rows bigint, branches integer, match_depth integer,
               full_match boolean, coinbase_prefix boolean, coinbase_suffix boolean, coinbase_layout boolean)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    t_from timestamptz;
    t_to   timestamptz;
BEGIN
    IF h_to < h_from OR h_to - h_from > 1000 THEN
        RAISE EXCEPTION 'block_template_matches: at most 1000 heights (got % .. %)', h_from, h_to;
    END IF;
    -- templates for h arrive after block h-1 and before h (header times can be ~2 h off): pad generously
    SELECT min(b.block_time) - interval '6 hours', max(b.block_time) + interval '6 hours'
      INTO t_from, t_to FROM blocks b WHERE b.height BETWEEN h_from - 1 AND h_to;
    IF t_from IS NULL THEN
        RETURN;
    END IF;
    RETURN QUERY EXECUTE format($q$
        WITH blk AS (
            SELECT b.height, b.block_hash, b.mining_pool->>'name' AS block_pool, b.merkle_branches AS bmb, b.coinbase_tx
            FROM blocks_best b WHERE b.height BETWEEN %1$s AND %2$s AND b.merkle_branches IS NOT NULL
        ), sets AS (
            SELECT t.height, t.merkle_branches AS tmb FROM templates t
            WHERE t.height BETWEEN %1$s AND %2$s AND t.received_at >= %3$L AND t.received_at < %4$L
            GROUP BY 1, 2
        ), depth AS (
            SELECT s.height, s.tmb, blk.block_hash,
                   coalesce((SELECT min(i) FROM generate_series(0, least(length(s.tmb), length(blk.bmb)) / 32 - 1) i
                             WHERE substring(s.tmb FROM i * 32 + 1 FOR 32) <> substring(blk.bmb FROM i * 32 + 1 FOR 32)),
                            least(length(s.tmb), length(blk.bmb)) / 32) AS d,
                   s.tmb = blk.bmb AS full_match
            FROM sets s JOIN blk USING (height)
        )
        SELECT t.height, hash_display(blk.block_hash) AS block_hash, blk.block_pool, t.source_id, src.name, src.site,
               src.replica, min(t.job_id), min(t.received_at), count(*), (length(t.merkle_branches) / 32)::integer,
               depth.d::integer, depth.full_match,
               bool_or(substring(blk.coinbase_tx FROM 1 FOR length(t.coinbase1)) = t.coinbase1),
               bool_or(substring(blk.coinbase_tx FROM length(blk.coinbase_tx) - length(t.coinbase2) + 1) = t.coinbase2),
               bool_or(length(blk.coinbase_tx) - length(t.coinbase1) - length(t.coinbase2)
                       = length(t.extranonce1) + t.extranonce2_length)
        FROM templates t
        JOIN depth ON depth.height = t.height AND depth.tmb = t.merkle_branches
        JOIN blk ON blk.height = t.height AND blk.block_hash = depth.block_hash
        JOIN sources src ON src.id = t.source_id
        WHERE t.height BETWEEN %1$s AND %2$s AND t.received_at >= %3$L AND t.received_at < %4$L
          AND (depth.d >= 1 OR depth.full_match)
        GROUP BY t.height, blk.block_hash, blk.block_pool, t.source_id, src.name, src.site, src.replica,
                 t.merkle_branches, depth.d, depth.full_match
        ORDER BY t.height, depth.full_match DESC, depth.d DESC, min(t.received_at)
    $q$, h_from, h_to, t_from, t_to);
END $$;
GRANT EXECUTE ON FUNCTION block_template_matches(integer, integer) TO stratum_backend, stratum_web;

-- migrate:down
DROP FUNCTION IF EXISTS block_template_matches(integer, integer);
-- the view depends on the columns: drop it, drop them, and re-create it exactly as 20261116300001 left it (the
-- columns blocks had then; not seen_via, so 20261118000001's down can still drop that column)
DROP VIEW blocks_best;
ALTER TABLE blocks DROP COLUMN coinbase_tx, DROP COLUMN coinbase_txid, DROP COLUMN merkle_branches;
CREATE VIEW blocks_best WITH (security_invoker = true) AS
SELECT b.block_hash, b.height, b.block_time, b.seen_at, b.coinbase_script_sig, b.pool_id, b.mining_pool, b.analysis,
       b.tx_count, b.size, b.weight, b.version, b.merkle_root, b.bits, b.nonce, b.difficulty
  FROM blocks b
 WHERE NOT EXISTS (SELECT 1 FROM stale_blocks s WHERE s.block_hash = b.block_hash AND s.reorged_in_at IS NULL);
GRANT SELECT ON blocks_best TO stratum_backend, stratum_web;
