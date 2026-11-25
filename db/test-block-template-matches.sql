-- block_template_matches (stratum-work#235) on a synthetic block: coinbase + 7 transactions (3 branches), and an
-- empty block. Generated from backend/coinbase.py; asserts every match state.
INSERT INTO sources (name, site, replica) VALUES ('Winner','s','0'), ('Winner','s','1'), ('Sharer','s','0'), ('Partial','s','0'), ('Other','s','0');
INSERT INTO blocks (block_hash, height, block_time, coinbase_script_sig, mining_pool, merkle_branches, coinbase_txid, coinbase_tx) VALUES
  (decode('000000000000000000000000000000000000000000000000000000000000005c783031','hex'), 975501, now() - interval '1 hour', '\x00', '{"name": "Winner"}', decode('9c12cfdc04c74584d787ac3d23772132c18524bc7ab28dec4219b8fc5b425f705469b9f8688bf3332b52548d8c9b1e3f055d44919e817b139c0c1223e821c8e11083f3c1372c20be053fd1d02aa600c0c5f1a92141906308a8174f60491a4dcd','hex'), decode('3ccffc24284709b4f4b860e05ab7840aa805990a8aabc549b4eed015fe744438','hex'), decode('01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff2003a0e40e2f73796e7468657469632faabbccdd0000000000000000ffffffff0100f2052a01000000016a00000000','hex')),
  (decode('000000000000000000000000000000000000000000000000000000000000005c783032','hex'), 975502, now() - interval '50 minutes', '\x00', '{"name": "Winner"}', '\x', decode('c7a6b2fc6bb2755d227ceff79dbeebe167b88b432d1d6b2a2c1a12ef5acdf2f9','hex'), decode('01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff2003a0e40e2f73796e74686574454d50aabbccdd0000000000000000ffffffff0100f2052a01000000016a00000000','hex'));
INSERT INTO templates (source_id, received_at, height, job_id, prev_hash, coinbase1, coinbase2, merkle_branches, version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length)
SELECT s.id, now() - interval '61 minutes' + v.ms * interval '1 ms', 975501, v.job, '\x00', v.c1, v.c2, v.mb, 1, 1, 1, true, v.en1, 8
FROM (VALUES
  ('Winner', '0', 'w1', 0,  decode('01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff2003a0e40e2f73796e7468657469632f','hex'), decode('ffffffff0100f2052a01000000016a00000000','hex'), decode('9c12cfdc04c74584d787ac3d23772132c18524bc7ab28dec4219b8fc5b425f705469b9f8688bf3332b52548d8c9b1e3f055d44919e817b139c0c1223e821c8e11083f3c1372c20be053fd1d02aa600c0c5f1a92141906308a8174f60491a4dcd','hex'), decode('01020304','hex')),
  ('Winner', '0', 'w1', 30000, decode('01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff2003a0e40e2f73796e7468657469632f','hex'), decode('ffffffff0100f2052a01000000016a00000000','hex'), decode('9c12cfdc04c74584d787ac3d23772132c18524bc7ab28dec4219b8fc5b425f705469b9f8688bf3332b52548d8c9b1e3f055d44919e817b139c0c1223e821c8e11083f3c1372c20be053fd1d02aa600c0c5f1a92141906308a8174f60491a4dcd','hex'), decode('01020304','hex')),    -- a re-send
  ('Winner', '1', 'w2', 40, decode('01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff2003a0e40e2f73796e7468657469632f','hex'), decode('ffffffff0100f2052a01000000016a00000000','hex'), decode('9c12cfdc04c74584d787ac3d23772132c18524bc7ab28dec4219b8fc5b425f705469b9f8688bf3332b52548d8c9b1e3f055d44919e817b139c0c1223e821c8e11083f3c1372c20be053fd1d02aa600c0c5f1a92141906308a8174f60491a4dcd','hex'), decode('05060708','hex')),
  ('Sharer', '0', 's1', 10, decode('6f746865722d706f6f6c2d7072656669782d6c6f6e676572000000000000000000000000000000000000000000000000000000000000','hex'), decode('0100f2052a01000000016a00000000','hex'), decode('9c12cfdc04c74584d787ac3d23772132c18524bc7ab28dec4219b8fc5b425f705469b9f8688bf3332b52548d8c9b1e3f055d44919e817b139c0c1223e821c8e11083f3c1372c20be053fd1d02aa600c0c5f1a92141906308a8174f60491a4dcd','hex'), decode('0102','hex')),
  ('Partial','0', 'p1', 20, decode('01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff2003a0e40e2f73796e7468657469632f','hex'), decode('ffffffff0100f2052a01000000016a00000000','hex'), decode('9c12cfdc04c74584d787ac3d23772132c18524bc7ab28dec4219b8fc5b425f705469b9f8688bf3332b52548d8c9b1e3f055d44919e817b139c0c1223e821c8e12af866d93e14e360f8fd4fd8c25a89bca2350f52530d0592e966834fe24b007f','hex'), decode('01020304','hex')),
  ('Other',  '0', 'o1', 30, decode('01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff2003a0e40e2f73796e7468657469632f','hex'), decode('ffffffff0100f2052a01000000016a00000000','hex'), decode('00000000000000000000000000000000000000000000000000000000000000005469b9f8688bf3332b52548d8c9b1e3f055d44919e817b139c0c1223e821c8e11083f3c1372c20be053fd1d02aa600c0c5f1a92141906308a8174f60491a4dcd','hex'), decode('01020304','hex'))
) v(pool, rep, job, ms, c1, c2, mb, en1) JOIN sources s ON s.name = v.pool AND s.replica = v.rep;
INSERT INTO templates (source_id, received_at, height, job_id, prev_hash, coinbase1, coinbase2, merkle_branches, version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length)
SELECT id, now() - interval '55 minutes', 975502, 'e1', '\x00', decode('01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff2003a0e40e2f73796e7468657469632f','hex'), decode('ffffffff0100f2052a01000000016a00000000','hex'), '\x', 1, 1, 1, true, decode('01020304','hex'), 8 FROM sources WHERE name IN ('Winner', 'Other') AND replica = '0';

DO $$
DECLARE r record;
BEGIN
  -- Winner replica 0: full match, coinbase brackets and layout, its two rows grouped, first arrival kept
  SELECT * INTO r FROM block_template_matches(975501, 975501) m WHERE m.pool = 'Winner' AND m.replica = '0';
  IF NOT (r.full_match AND r.match_depth = 3 AND r.branches = 3 AND r.coinbase_prefix AND r.coinbase_suffix AND r.coinbase_layout AND r.n_rows = 2 AND r.block_pool = 'Winner') THEN
    RAISE EXCEPTION 'Winner/0: %', r; END IF;
  -- the block hash as stored (display order, like every other read), not reversed (20261125000001)
  IF r.block_hash <> '000000000000000000000000000000000000000000000000000000000000005c783031' THEN
    RAISE EXCEPTION 'block_hash order: %', r.block_hash; END IF;
  -- Winner replica 1 (another extranonce1 of the same length): also a full match
  SELECT * INTO r FROM block_template_matches(975501, 975501) m WHERE m.pool = 'Winner' AND m.replica = '1';
  IF NOT (r.full_match AND r.coinbase_layout) THEN RAISE EXCEPTION 'Winner/1: %', r; END IF;
  -- Sharer: same transaction set, a different pool's coinbase: full match, no brackets, not its layout
  SELECT * INTO r FROM block_template_matches(975501, 975501) m WHERE m.pool = 'Sharer';
  IF NOT (r.full_match AND NOT r.coinbase_prefix AND NOT r.coinbase_layout) THEN RAISE EXCEPTION 'Sharer: %', r; END IF;
  -- Partial: the first 3 transactions agree (2 branches), the rest don't
  SELECT * INTO r FROM block_template_matches(975501, 975501) m WHERE m.pool = 'Partial';
  IF NOT (NOT r.full_match AND r.match_depth = 2) THEN RAISE EXCEPTION 'Partial: %', r; END IF;
  -- Other: a different first transaction: not listed
  IF EXISTS (SELECT 1 FROM block_template_matches(975501, 975501) m WHERE m.pool = 'Other') THEN RAISE EXCEPTION 'Other listed'; END IF;
  -- the empty block: every empty template "matches" (0 branches: proves nothing), coinbase only fits its own
  IF (SELECT count(*) FROM block_template_matches(975502, 975502) m WHERE m.full_match AND m.branches = 0) <> 2 THEN
    RAISE EXCEPTION 'empty block: %', (SELECT array_agg(m.pool) FROM block_template_matches(975502, 975502) m); END IF;
  -- order: full matches first, then by depth, then first arrival
  IF (SELECT array_agg(m.pool || '/' || m.replica) FROM block_template_matches(975501, 975501) m) <> ARRAY['Winner/0', 'Sharer/0', 'Winner/1', 'Partial/0'] THEN
    RAISE EXCEPTION 'order: %', (SELECT array_agg(m.pool || '/' || m.replica) FROM block_template_matches(975501, 975501) m); END IF;
  -- range guard
  BEGIN PERFORM block_template_matches(1, 5000); RAISE EXCEPTION 'no range guard';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE '%%at most 1000 heights%%' THEN RAISE; END IF; END;
END $$;
DELETE FROM templates WHERE height IN (975501, 975502);
DELETE FROM blocks WHERE height IN (975501, 975502);
DELETE FROM sources WHERE name IN ('Winner', 'Sharer', 'Partial', 'Other');
