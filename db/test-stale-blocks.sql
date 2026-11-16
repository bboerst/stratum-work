-- Stale blocks and the stale-tip read (stale_blocks / chain_reorgs / stale_tip_templates,
-- 20261116100001_stale_blocks.sql) on synthetic data. Run by db/test-migrations.sh as the superuser, in a transaction
-- that is rolled back: inserts as the superuser, reads as the web and backend roles. Any failed ASSERT aborts.
BEGIN;

-- Byte order: block hash (display order) words w0..w7 -> stratum prev_hash w7..w0, bytes inside a word unchanged.
DO $$
DECLARE disp bytea := '\x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
        strat bytea := '\x1c1d1e1f18191a1b14151617101112130c0d0e0f08090a0b0405060700010203';
BEGIN
  ASSERT stratum_prev_hash_to_block_hash(strat) = disp, 'stratum -> display';
  ASSERT stratum_prev_hash_to_block_hash(disp) = strat, 'the conversion is its own inverse';
  ASSERT stratum_prev_hash_to_block_hash('\x0102') IS NULL, 'not 32 bytes: NULL';
END $$;

INSERT INTO sources (name, site, replica) VALUES ('ts-p1', 's1', 'a'), ('ts-p2', 's1', 'a'), ('ts-p2', 's1', 'b'),
                                                 ('ts-p3', 's1', 'a');

-- Block hashes (display order). b99: best at 975699. s99: a competing block there (stale, never active).
-- a00: was our tip at 975700 until a reorg; c00: the block that replaced it. x01: stale once, active again.
CREATE TEMP TABLE ts_h ON COMMIT DROP AS SELECT * FROM (VALUES
  ('b99', '\x0000000099999999999999999999999999999999999999999999999999999999'::bytea),
  ('s99', '\x00000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'::bytea),
  ('u99', '\x00000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'::bytea),
  ('a00', '\x00000000cccccccccccccccccccccccccccccccccccccccccccccccccccccccc'::bytea),
  ('c00', '\x00000000dddddddddddddddddddddddddddddddddddddddddddddddddddddddd'::bytea),
  ('x01', '\x00000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'::bytea),
  ('u09', '\x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff'::bytea)
) v (k, h);
GRANT SELECT ON ts_h TO stratum_web, stratum_backend;
CREATE FUNCTION pg_temp.h(k text) RETURNS bytea LANGUAGE sql AS $$ SELECT h FROM ts_h WHERE ts_h.k = $1 $$;

-- T0 = 2026-11-16 00:00 UTC
INSERT INTO blocks (block_hash, height, block_time, seen_at, coinbase_script_sig) VALUES
  (pg_temp.h('b99'), 975699, '2026-11-16 00:00:00+00', '2026-11-16 00:00:10+00', '\x00'),
  (pg_temp.h('a00'), 975700, '2026-11-16 00:05:00+00', '2026-11-16 00:05:00+00', '\x00'),   -- reorged out
  (pg_temp.h('c00'), 975700, '2026-11-16 00:05:01+00', '2026-11-16 00:06:40+00', '\x00'),
  (pg_temp.h('x01'), 975701, '2026-11-16 00:10:00+00', '2026-11-16 00:10:00+00', '\x00');

INSERT INTO chain_reorgs (detected_at, fork_height, depth, old_tip_hash, old_tip_height, new_tip_hash, new_tip_height)
VALUES ('2026-11-16 00:06:40+00', 975699, 1, pg_temp.h('a00'), 975700, pg_temp.h('c00'), 975700);

INSERT INTO stale_blocks (block_hash, height, prev_hash, version, block_time, bits, nonce, merkle_root, chaintip_status,
                          last_status, tip_hash, fork_height, was_active, reorg_id, reorged_in_at, full_block,
                          coinbase_script_sig, coinbase_outputs, tx_count, pool_id, mining_pool) VALUES
  (pg_temp.h('s99'), 975699, '\x01', 536870912, '2026-11-16 00:00:01+00', 386000000, 1, '\x02', 'valid-fork',
   'valid-fork', pg_temp.h('s99'), 975698, false, NULL, NULL, true, '\x03aa', '[{"value_sat": 1, "script_pubkey": "51", "address": null}]',
   1, 9, '{"id": 9, "name": "Synthetic"}'),
  (pg_temp.h('a00'), 975700, pg_temp.h('b99'), 536870912, '2026-11-16 00:05:00+00', 386000000, 2, '\x02', 'valid-fork',
   'valid-fork', pg_temp.h('a00'), 975699, true, (SELECT max(id) FROM chain_reorgs), NULL, true, '\x03bb', '[]', 1, NULL, '{}'),
  (pg_temp.h('x01'), 975701, pg_temp.h('c00'), 536870912, '2026-11-16 00:10:00+00', 386000000, 3, '\x02', 'headers-only',
   'active', pg_temp.h('x01'), 975700, false, NULL, '2026-11-16 00:11:00+00', false, NULL, NULL, NULL, NULL, NULL);

-- templates (source, seconds after T0, height, job, prev block key)
INSERT INTO templates (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2, merkle_branches,
                       version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length)
SELECT '2026-11-16 00:00:00+00'::timestamptz + make_interval(secs => r.s), src.id, r.height, r.job,
       stratum_prev_hash_to_block_hash(pg_temp.h(r.prev)), '\x01', '\x02', '', 536870912, 386000000, r.ntime, true, '\x03', 8
  FROM (VALUES
    -- 975700 (built on 975699): p1 on the best block, p2 on the stale s99 (3 templates, the last 5 s after our node
    -- had b99; replica b's exact copy is hidden), p3 on a tip nobody recorded
    ('ts-p1', 'a', 11.0, 975700, 'j1', 'b99', 100),
    ('ts-p2', 'a',  2.0, 975700, 'j2', 's99', 100),
    ('ts-p2', 'b',  1.5, 975700, 'j2b', 's99', 100),
    ('ts-p2', 'a',  8.0, 975700, 'j3', 's99', 101),
    ('ts-p2', 'a', 15.0, 975700, 'j4', 's99', 102),
    ('ts-p3', 'a', 12.0, 975700, 'j5', 'u99', 100),
    ('ts-p2', 'a', 16.0, 975700, 'j6', 'b99', 103),
    -- 975701 (built on 975700): p1 on a00, our old tip (reorged out at 00:06:40), p2 on c00 (best)
    ('ts-p1', 'a', 360.0, 975701, 'k1', 'a00', 200),
    ('ts-p1', 'a', 401.0, 975701, 'k2', 'a00', 201),
    ('ts-p2', 'a', 399.0, 975701, 'k3', 'c00', 200),
    -- 975702 (built on 975701): x01 was recorded stale but is on the active chain again: best, not reported
    ('ts-p1', 'a', 610.0, 975702, 'l1', 'x01', 300),
    -- 975710: no block at 975709 in blocks: an unknown prev_hash can't be judged, not reported
    ('ts-p3', 'a', 900.0, 975710, 'm1', 'u09', 400)
  ) r (pool, replica, s, height, job, prev, ntime)
  JOIN sources src ON src.name = r.pool AND src.site = 's1' AND src.replica = r.replica;

CREATE FUNCTION pg_temp.ts_check() RETURNS void LANGUAGE plpgsql AS $$
DECLARE j record; n integer; got text;
BEGIN
  SELECT string_agg(format('%s:%s:%s', s.height, s.pool, s.tip), ',' ORDER BY s.height, s.pool) INTO got
    FROM stale_tip_templates(975690, 975720) s;
  ASSERT got = '975700:ts-p2:stale,975700:ts-p3:unknown,975701:ts-p1:stale', format('stale-tip rows: %s', got);

  SELECT * INTO j FROM stale_tip_templates(975700, 975700) s WHERE s.pool = 'ts-p2';
  ASSERT j.stale_block_hash = pg_temp.h('s99') AND j.prev_block_hash = pg_temp.h('s99') AND j.stale_height = 975699,
         format('p2 stale link %s', row_to_json(j));
  ASSERT j.templates = 3, format('p2 templates (exact replica copy hidden): %s', j.templates);
  ASSERT j.first_template_at = '2026-11-16 00:00:01.5+00' AND j.last_template_at = '2026-11-16 00:00:15+00',
         format('p2 times %s', row_to_json(j));
  ASSERT j.node_switch_at = '2026-11-16 00:00:10+00' AND j.mined_after_switch = interval '5 s',
         format('p2 switch %s', row_to_json(j));
  ASSERT j.stale_mining_pool->>'name' = 'Synthetic' AND j.stale_full_block AND NOT j.stale_was_active
         AND j.best_block_hash = pg_temp.h('b99'), format('p2 stale details %s', row_to_json(j));

  SELECT * INTO j FROM stale_tip_templates(975700, 975700) s WHERE s.pool = 'ts-p3';
  ASSERT j.stale_block_hash IS NULL AND j.prev_block_hash = pg_temp.h('u99') AND j.templates = 1
         AND j.mined_after_switch = interval '2 s', format('p3 unknown %s', row_to_json(j));

  SELECT * INTO j FROM stale_tip_templates(975701, 975701) s;
  ASSERT j.stale_was_active AND j.reorg_id IS NOT NULL AND j.best_block_hash = pg_temp.h('c00')
         AND j.node_switch_at = '2026-11-16 00:06:40+00' AND j.templates = 2
         AND j.mined_after_switch = interval '1 s', format('p1 reorged-out tip %s', row_to_json(j));

  SELECT count(*) INTO n FROM stale_tip_templates(975702, 975702);
  ASSERT n = 0, 'a block active again is the best chain';
  SELECT count(*) INTO n FROM stale_tip_templates(975710, 975710);
  ASSERT n = 0, 'no best block at height - 1: unknown prev_hash not judged';
  SELECT count(*) INTO n FROM stale_tip_templates(975800, 975900);
  ASSERT n = 0, 'empty range';
  SELECT count(*) INTO n FROM stale_blocks WHERE reorged_in_at IS NULL;
  ASSERT n = 2, 'stale blocks readable';
  SELECT count(*) INTO n FROM chain_reorgs;
  ASSERT n >= 1, 'reorgs readable';
END $$;

SET ROLE stratum_web;
SELECT pg_temp.ts_check();
RESET ROLE;
SET ROLE stratum_backend;
SELECT pg_temp.ts_check();
RESET ROLE;

ROLLBACK;
