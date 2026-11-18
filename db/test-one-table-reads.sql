-- One templates table, step 1 (20261118000006_one_table_reads.sql) on synthetic data: height windows, the bounded
-- templates_copies() / templates_dedup() against the views they replace, the stale filter, inlining, and
-- stale_tip_templates() ignoring rows outside the window. Run by db/test-migrations.sh as the superuser in a rolled-back
-- transaction. Any failed ASSERT aborts with an error.
BEGIN;
INSERT INTO sources (name, site, replica) VALUES ('ot-p1', 's1', 'a'), ('ot-p1', 's1', 'b'), ('ot-p2', 's1', 'a');
CREATE TEMP TABLE ot_src ON COMMIT DROP AS SELECT id, name || '/' || replica AS k FROM sources WHERE name LIKE 'ot-%';
-- blocks 975700..975706 every 10 min, a gap at 975703; T0 = 975700's arrival
CREATE TEMP TABLE ot_t0 ON COMMIT DROP AS SELECT timestamptz '2026-11-10 00:00:00+00' AS t0;
INSERT INTO blocks (block_hash, height, block_time, seen_at, coinbase_script_sig)
SELECT decode(lpad(to_hex(h), 64, '0'), 'hex'), h, t0 + (h - 975700) * interval '10 min', t0 + (h - 975700) * interval '10 min', '\x00'
  FROM generate_series(975700, 975706) h, ot_t0 WHERE h <> 975703;
-- prev_hash of a template at height h = the block at h - 1, in stratum's word order
CREATE TEMP TABLE ot_rows ON COMMIT DROP AS
SELECT s.id AS source_id, t0 + (r.h - 975701) * interval '10 min' + r.sec * interval '1 s' AS received_at, r.h AS height,
       r.job, stratum_prev_hash_to_block_hash(decode(lpad(to_hex(r.parent), 64, '0'), 'hex')) AS prev_hash,
       decode(r.mb, 'hex') AS merkle_branches, r.ntime
  FROM (VALUES
    ('ot-p1/a', 975701,   1.0, 'j1', 975700, 'aa', 1000), ('ot-p1/b', 975701,   1.1, 'j1', 975700, 'aa', 1000),  -- copy
    ('ot-p1/b', 975701,  40.0, 'j2', 975700, 'bb', 1040),                                                          -- secondary stream
    ('ot-p2/a', 975701,   2.0, 'k1', 975700, 'cc', 1001),
    ('ot-p1/a', 975702,   1.0, 'j3', 975701, 'dd', 1600), ('ot-p2/a', 975702, 3.0, 'k2', 975701, 'ee', 1601),
    ('ot-p1/a', 975704,   1.0, 'j4', 975703, 'ff', 2800),                                                          -- parent in the gap
    ('ot-p1/a', 975706,  30.0, 'j5', 975705, '11', 4000),                                                          -- the tip height
    ('ot-p2/a', 975702, 86400, 'stale', 975701, '22', 1602),   -- a stuck feed re-sending 975702's job a day later
    ('ot-p2/a', 975701, 172800, 'other', 999999, '33', 9000)   -- another chain at a past Bitcoin height, 2 days later
  ) r(k, h, sec, job, parent, mb, ntime)
  JOIN ot_src s ON s.k = r.k, ot_t0;
INSERT INTO templates (source_id, received_at, height, job_id, prev_hash, coinbase1, coinbase2, merkle_branches, version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length)
SELECT source_id, received_at, height, job, prev_hash, '\x01', '\x02', merkle_branches, 536870912, 386000000, ntime, true, '\x03', 4 FROM ot_rows;

DO $$
DECLARE t0 timestamptz := (SELECT t0 FROM ot_t0); r record; n bigint; plan text;
BEGIN
  -- windows: [arrival(h-1) - 2 h, arrival(h) + 2 h]; the gap at 975703 widens 975703/975704; above the tip: open
  SELECT * INTO r FROM template_height_windows(975702, 975702);
  ASSERT r.w_from = t0 + interval '10 min' - interval '2 hours' AND r.w_to = t0 + interval '20 min' + interval '2 hours', format('975702: %s', r);
  SELECT * INTO r FROM template_height_windows(975704, 975704);
  ASSERT r.w_from = t0 + interval '20 min' - interval '2 hours', format('975704 lower bound uses 975702 (gap): %s', r);
  SELECT * INTO r FROM template_height_windows(975703, 975703);
  ASSERT r.w_to = t0 + interval '40 min' + interval '2 hours', format('975703 upper bound uses 975704 (gap): %s', r);
  SELECT * INTO r FROM template_height_windows(975707, 975707);
  ASSERT r.w_to = 'infinity' AND r.w_from = t0 + interval '60 min' - interval '2 hours', format('above the tip: %s', r);
  SELECT * INTO r FROM height_window(975701, 975706);
  ASSERT r.t_from = t0 - interval '2 hours' AND r.t_to = t0 + interval '60 min' + interval '2 hours', format('range: %s', r);

  -- parity: with an open time range, the functions return exactly what the views return
  SELECT count(*) INTO n FROM (
    (SELECT * FROM templates_copies(975700, 975710, '-infinity', 'infinity') EXCEPT ALL SELECT * FROM templates_copies WHERE height BETWEEN 975700 AND 975710)
    UNION ALL
    (SELECT * FROM templates_copies WHERE height BETWEEN 975700 AND 975710 EXCEPT ALL SELECT * FROM templates_copies(975700, 975710, '-infinity', 'infinity'))) d;
  ASSERT n = 0, format('templates_copies parity: %s differing rows', n);
  SELECT count(*) INTO n FROM (
    (SELECT * FROM templates_dedup(975700, 975710, '-infinity', 'infinity') EXCEPT ALL SELECT * FROM templates_dedup WHERE height BETWEEN 975700 AND 975710)
    UNION ALL
    (SELECT * FROM templates_dedup WHERE height BETWEEN 975700 AND 975710 EXCEPT ALL SELECT * FROM templates_dedup(975700, 975710, '-infinity', 'infinity'))) d;
  ASSERT n = 0, format('templates_dedup parity: %s differing rows', n);
  ASSERT (SELECT count(*) FROM templates_dedup(975700, 975710, '-infinity', 'infinity')) > 0, 'parity compared nothing';

  -- the window keeps out the stale re-send and the other chain's row; the rest of 975701/975702 stays
  SELECT count(*) INTO n FROM templates_dedup(975702, 975702, (SELECT t_from FROM height_window(975702, 975702)), (SELECT t_to FROM height_window(975702, 975702))) WHERE job_id = 'stale';
  ASSERT n = 0, 'stale re-send inside the window';
  ASSERT (SELECT count(*) FROM templates_dedup(975702, 975702, '-infinity', 'infinity') WHERE job_id = 'stale') = 1, 'stale row missing from the open read';
  SELECT count(*) INTO n FROM templates_dedup(975701, 975701, (SELECT t_from FROM height_window(975701, 975701)), (SELECT t_to FROM height_window(975701, 975701)));
  ASSERT n = (SELECT count(*) FROM templates_dedup WHERE height = 975701 AND job_id <> 'other'), format('975701 windowed: %s rows', n);
  -- the stale row can't become a primary: p2's primary at 975702 is k2
  ASSERT (SELECT array_agg(job_id ORDER BY job_id) FROM templates_dedup(975702, 975702, t0 - interval '1 day', t0 + interval '1 day') WHERE pool = 'ot-p2') = ARRAY['k2'], 'p2 primary at 975702';

  -- inlined: no Function Scan in the plan (the bounds reach the scan of templates)
  EXECUTE $q$EXPLAIN (FORMAT JSON) SELECT * FROM templates_dedup(975701, 975701, '2026-11-09 22:00+00', '2026-11-10 02:00+00')$q$ INTO plan;
  -- a function that isn't inlined shows as a Function Scan of itself (the unnest() subqueries inside are fine)
  ASSERT plan NOT LIKE '%"Function Name": "templates_dedup"%' AND plan NOT LIKE '%"Function Name": "templates_copies"%', 'templates_dedup() not inlined';
  ASSERT plan LIKE '%"Relation Name": "templates"%' OR plan LIKE '%_hyper_%', 'the plan does not scan templates directly';
  ASSERT plan LIKE '%received_at%', 'the time bound is not in the plan';
  EXECUTE $q$EXPLAIN (FORMAT JSON) SELECT * FROM templates_copies(975701, 975701, '2026-11-09 22:00+00', '2026-11-10 02:00+00')$q$ INTO plan;
  ASSERT plan NOT LIKE '%"Function Name": "templates_copies"%', 'templates_copies() not inlined';

  -- stale_tip_templates: the stale re-send (on the best tip) and the other chain's row (unknown parent, 2 days later)
  -- are outside their windows: no 'unknown' tip from them
  ASSERT NOT EXISTS (SELECT 1 FROM stale_tip_templates(975701, 975706) s WHERE s.pool LIKE 'ot-%'),
         format('stale_tip_templates: %s', (SELECT array_agg(s.pool || '@' || s.height || ':' || s.tip) FROM stale_tip_templates(975701, 975706) s));
END $$;

-- bitcoin_parents: a template's raw prev_hash joins it
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM templates t JOIN bitcoin_parents p ON p.prev_hash = t.prev_hash WHERE t.job_id = 'j3') = 1, 'j3 has a Bitcoin parent';
  ASSERT NOT EXISTS (SELECT 1 FROM templates t JOIN bitcoin_parents p ON p.prev_hash = t.prev_hash WHERE t.job_id = 'other'), 'other has none';
END $$;
ROLLBACK;
