-- blocks_best (20261116300001_blocks_best.sql) on synthetic data. Run by db/test-migrations.sh as the superuser, in a
-- transaction that is rolled back: inserts as the superuser, reads as the web and backend roles. Any failed ASSERT
-- aborts.
BEGIN;

-- 975800: two blocks, the one seen first was reorged out (stale), the other replaced it.
-- 975801: a block recorded stale once and active again (shown).
-- 975802: a block with no stale_blocks row (unchanged behavior).
-- 975803: a block that was active again and went stale once more (reorged_in_at back to NULL: hidden).
INSERT INTO blocks (block_hash, height, block_time, seen_at, coinbase_script_sig) VALUES
  ('\x00000000a0', 975800, '2026-11-16 00:00:00+00', '2026-11-16 00:00:00+00', '\x00'),
  ('\x00000000b0', 975800, '2026-11-16 00:00:01+00', '2026-11-16 00:01:00+00', '\x00'),
  ('\x00000000c1', 975801, '2026-11-16 00:10:00+00', '2026-11-16 00:10:00+00', '\x00'),
  ('\x00000000d2', 975802, '2026-11-16 00:20:00+00', '2026-11-16 00:20:00+00', '\x00'),
  ('\x00000000e3', 975803, '2026-11-16 00:30:00+00', '2026-11-16 00:30:00+00', '\x00');

INSERT INTO stale_blocks (block_hash, height, prev_hash, version, block_time, bits, nonce, merkle_root, chaintip_status,
                          last_status, tip_hash, fork_height, was_active, reorged_in_at) VALUES
  ('\x00000000a0', 975800, '\x01', 1, '2026-11-16 00:00:00+00', 1, 1, '\x02', 'valid-fork', 'valid-fork',
   '\x00000000a0', 975799, true, NULL),
  ('\x00000000c1', 975801, '\x01', 1, '2026-11-16 00:10:00+00', 1, 1, '\x02', 'valid-fork', 'active',
   '\x00000000c1', 975800, true, '2026-11-16 00:11:00+00'),
  ('\x00000000e3', 975803, '\x01', 1, '2026-11-16 00:30:00+00', 1, 1, '\x02', 'valid-fork', 'valid-fork',
   '\x00000000e3', 975802, true, NULL),
  -- a stale block never stored in blocks: doesn't add a row to the view
  ('\x00000000f3', 975803, '\x01', 1, '2026-11-16 00:30:01+00', 1, 1, '\x02', 'valid-fork', 'valid-fork',
   '\x00000000f3', 975802, false, NULL);

SET LOCAL ROLE stratum_web;
DO $$
BEGIN
  ASSERT (SELECT string_agg(encode(block_hash, 'hex'), ',' ORDER BY height, block_hash) FROM blocks_best
           WHERE height BETWEEN 975800 AND 975803) = '00000000b0,00000000c1,00000000d2',
         'best chain: stale hidden, active-again shown, untouched shown';
  -- "the block at height h", as the web reads it (first seen wins among the non-stale blocks)
  ASSERT (SELECT encode(block_hash, 'hex') FROM blocks_best WHERE height = 975800
           ORDER BY seen_at ASC NULLS LAST, block_time, block_hash LIMIT 1) = '00000000b0',
         'block at a reorged height: the replacement, not the first-seen stale block';
  ASSERT (SELECT count(*) FROM blocks WHERE height BETWEEN 975800 AND 975803) = 5, 'blocks itself keeps every block';
  ASSERT (SELECT max(height) FROM blocks_best WHERE height BETWEEN 975800 AND 975803) = 975802,
         'the tip skips a stale block above it';
END $$;
RESET ROLE;

SET LOCAL ROLE stratum_backend;
DO $$
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM blocks_best WHERE height = 975803), 'backend: height with only stale blocks is empty';
  ASSERT EXISTS (SELECT 1 FROM blocks_best WHERE height = 975801), 'backend: active-again block counts';
END $$;
RESET ROLE;

-- a later reorg makes the stale block at 975803 active again: it reappears
UPDATE stale_blocks SET reorged_in_at = '2026-11-16 00:40:00+00', last_status = 'active' WHERE block_hash = '\x00000000e3';
DO $$
BEGIN
  ASSERT EXISTS (SELECT 1 FROM blocks_best WHERE block_hash = '\x00000000e3'), 'reorged in again: shown';
END $$;

-- with no stale_blocks rows the view is exactly blocks
DELETE FROM stale_blocks;
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM blocks_best) = (SELECT count(*) FROM blocks), 'no stale rows: view = blocks';
END $$;

ROLLBACK;
