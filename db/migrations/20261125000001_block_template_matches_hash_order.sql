-- migrate:up
-- block_template_matches (20261118000005) returned block_hash byte-reversed: blocks.block_hash is already in display
-- order (the order RPC shows), and hash_display() reversed it again. The same function with block_hash as stored
-- (encode(blocks.block_hash, 'hex'), display order, as every other read gives a block hash). Same signature and
-- result type, so CREATE OR REPLACE keeps the grants; only that one expression changes.
CREATE OR REPLACE FUNCTION block_template_matches(h_from integer, h_to integer)
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
        SELECT t.height, encode(blk.block_hash, 'hex') AS block_hash, blk.block_pool, t.source_id, src.name, src.site,
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

-- migrate:down
CREATE OR REPLACE FUNCTION block_template_matches(h_from integer, h_to integer)
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
