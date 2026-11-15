-- De-duplicated reads (templates_copies / templates_dedup / template_dedup_report, 20261115000001_templates_dedup.sql)
-- on synthetic data. Run by db/test-migrations.sh as the superuser, in a transaction that is rolled back: inserts as
-- the superuser, reads as the web and backend roles. Any failed ASSERT aborts with an error.
BEGIN;

INSERT INTO sources (name, site, replica) VALUES
  ('tj-p1', 's1', 'a'), ('tj-p1', 's1', 'b'), ('tj-p1', 's2', 'a'),   -- primary s1/a, secondaries s1/b and s2/a
  ('tj-p2', 's1', 'a'),                                               -- single collector
  ('tj-p3', 's1', 'a'),                                               -- single collector, with re-sends
  ('tj-p4', 's1', 'a'), ('tj-p4', 's2', 'a'), ('tj-p4', 's3', 'a');   -- three sites (regions); s1 is the primary

CREATE TEMP TABLE tj_src ON COMMIT DROP AS
  SELECT id, name || '/' || site || '/' || replica AS k FROM sources WHERE name LIKE 'tj-%';

-- (source, seconds after T0, height, job_id, branches byte, ntime, coinbase byte)
CREATE TEMP TABLE tj_rows ON COMMIT DROP AS SELECT * FROM (VALUES
  -- height 975600, tj-p1 primary (s1/a): job aa sent, then re-sent with a new ntime; template cc sent twice; job dd
  ('tj-p1/s1/a',  0.020, 975600, 'a-1', 'aa', 1000, 'a1'),
  ('tj-p1/s1/a', 30.000, 975600, 'a-2', 'aa', 1030, 'a2'),
  ('tj-p1/s1/a', 40.000, 975600, 'a-3', 'cc', 1100, 'a3'),
  ('tj-p1/s1/a', 41.000, 975600, 'a-4', 'cc', 1100, 'a4'),
  ('tj-p1/s1/a', 50.000, 975600, 'a-5', 'dd', 1200, 'a5'),
  -- secondary s1/b
  ('tj-p1/s1/b',  0.010, 975600, 'b-1', 'aa', 1000, 'b1'),   -- exact copy of a-1, 10 ms earlier: hidden
  ('tj-p1/s1/b', 30.500, 975600, 'b-2', 'aa', 1030, 'b2'),   -- exact copy of a-2, later: hidden
  ('tj-p1/s1/b', 40.500, 975600, 'b-3', 'cc', 1100, 'b3'),   -- 1st copy of cc -> pairs with a-3: hidden
  ('tj-p1/s1/b', 41.200, 975600, 'b-4', 'cc', 1100, 'b4'),   -- 2nd copy -> pairs with a-4: hidden
  ('tj-p1/s1/b', 42.000, 975600, 'b-5', 'cc', 1100, 'b5'),   -- 3rd copy, the primary has only two: shown ('extra')
  ('tj-p1/s1/b', 50.100, 975600, 'b-6', 'dd', 1203, 'b6'),   -- job dd with ntime +3: shown ('near_miss', 3 s)
  ('tj-p1/s1/b', 60.000, 975600, 'b-7', 'ee', 1300, 'b7'),   -- job the primary never sent: shown ('gap_fill')
  -- secondary s2/a
  ('tj-p1/s2/a',  0.001, 975600, 'c-1', 'aa', 1000, 'c1'),   -- exact copy of a-1, earliest of all: hidden
  ('tj-p1/s2/a',  0.500, 975600, 'c-2', 'aa', 1001, 'c2'),   -- job aa, ntime 1001: 'near_miss', 1 s (to 1000)
  -- height 975601: the usual primary (s1/a) has no rows, so s1/b is the primary there
  ('tj-p1/s1/b', 100.000, 975601, 'b-8', 'ff', 1400, 'b8'),
  ('tj-p1/s1/b', 101.000, 975601, 'b-9', 'ff', 1401, 'b9'),
  ('tj-p1/s2/a', 100.200, 975601, 'c-3', 'ff', 1400, 'c3'),  -- exact copy of b-8: hidden
  -- height 975602, next UTC day: a secondary copy 5 ms earlier
  ('tj-p1/s1/a', 86410.000, 975602, 'a-6', 'aa', 9000, 'a6'),
  ('tj-p1/s1/b', 86409.995, 975602, 'b-10', 'aa', 9000, 'ba'),
  -- tj-p2: the same template as a-1, another pool: never merged
  ('tj-p2/s1/a',  0.005, 975600, 'p2-1', 'aa', 1000, 'd1'),
  -- tj-p3, one collector: a re-send with a new ntime and an exact repeat are all kept
  ('tj-p3/s1/a',  1.000, 975600, 'p3-1', 'aa', 1000, 'e1'),
  ('tj-p3/s1/a',  2.000, 975600, 'p3-2', 'aa', 1001, 'e2'),
  ('tj-p3/s1/a',  3.000, 975600, 'p3-3', 'aa', 1001, 'e3'),
  -- tj-p4, three sites: one template seen everywhere at different times, one only at s3, a near miss at s2
  ('tj-p4/s1/a',  1.000, 975600, 'q1', '44', 2000, 'f1'),
  ('tj-p4/s2/a',  0.900, 975600, 'q2', '44', 2000, 'f2'),    -- exact copy, 100 ms before the primary: hidden
  ('tj-p4/s3/a',  1.200, 975600, 'q3', '44', 2000, 'f3'),    -- exact copy, later: hidden
  ('tj-p4/s3/a',  5.000, 975600, 'q4', '55', 2100, 'f4'),    -- only s3 saw it: shown ('gap_fill')
  ('tj-p4/s2/a',  1.500, 975600, 'q5', '44', 2002, 'f5')     -- same job, ntime +2: shown ('near_miss', 2 s)
) v(k, s, height, job_id, br, ntime, cb);

INSERT INTO templates (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2, merkle_branches,
                       version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length, latency_ms, latency_method)
SELECT timestamptz '2030-06-01 00:00:00+00' + make_interval(secs => r.s), s.id, r.height, r.job_id,
       decode(repeat(to_hex(r.height % 256), 32), 'hex'), decode(r.cb || '01', 'hex'), decode(r.cb || '02', 'hex'),
       decode(repeat(r.br, 64), 'hex'), 536870912, 386000000, r.ntime, true, decode(r.cb, 'hex'), 8, r.s, 'tcp'
  FROM tj_rows r JOIN tj_src s ON s.k = r.k;

-- other chains: an exact copy on the secondary (hidden) and a near miss (shown)
INSERT INTO templates_other (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2, merkle_branches,
                             version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length, chain, reason)
SELECT timestamptz '2030-06-01 00:00:00+00' + make_interval(secs => v.s), s.id, 975600, v.job_id, '\x0b', '\x01',
       '\x02', '', 1, 2, v.ntime, true, '\x03', 8, 'bch', 'bch'
  FROM (VALUES ('tj-p1/s1/a', 2.0, 'oa', 3), ('tj-p1/s1/b', 1.0, 'ob', 3), ('tj-p1/s1/b', 1.5, 'oc', 4))
       v(k, s, job_id, ntime) JOIN tj_src s ON s.k = v.k;

CREATE FUNCTION pg_temp.tj_check() RETURNS void LANGUAGE plpgsql AS $$
DECLARE j record; n int; t0 timestamptz := '2030-06-01 00:00:00+00';
BEGIN
  -- one source per pool: identical to the raw rows (re-sends and exact repeats kept), all primary, nothing merged
  SELECT count(*) INTO n FROM (
    (SELECT received_at, source_id, job_id, prev_hash, coinbase1, coinbase2, merkle_branches, version, nbits, ntime,
            clean_jobs, extranonce1, extranonce2_length, latency_ms, latency_method
       FROM templates t WHERE height = 975600 AND source_id IN (SELECT id FROM sources WHERE name IN ('tj-p2', 'tj-p3'))
     EXCEPT ALL
     SELECT received_at, source_id, job_id, prev_hash, coinbase1, coinbase2, merkle_branches, version, nbits, ntime,
            clean_jobs, extranonce1, extranonce2_length, latency_ms, latency_method
       FROM templates_dedup WHERE height = 975600 AND pool IN ('tj-p2', 'tj-p3'))
    UNION ALL
    (SELECT received_at, source_id, job_id, prev_hash, coinbase1, coinbase2, merkle_branches, version, nbits, ntime,
            clean_jobs, extranonce1, extranonce2_length, latency_ms, latency_method
       FROM templates_dedup WHERE height = 975600 AND pool IN ('tj-p2', 'tj-p3')
     EXCEPT ALL
     SELECT received_at, source_id, job_id, prev_hash, coinbase1, coinbase2, merkle_branches, version, nbits, ntime,
            clean_jobs, extranonce1, extranonce2_length, latency_ms, latency_method
       FROM templates t WHERE height = 975600 AND source_id IN (SELECT id FROM sources WHERE name IN ('tj-p2', 'tj-p3')))
  ) d;
  ASSERT n = 0, format('single-source pools differ from the raw rows in %s rows', n);
  SELECT count(*) INTO n FROM templates_dedup WHERE height = 975600 AND pool = 'tj-p3'
                                                AND is_primary AND class = 'primary' AND copies = 1 AND first_seen = received_at;
  ASSERT n = 3, format('tj-p3: %s of 3 rows shown as plain primary rows', n);

  -- tj-p1 at 975600: 14 raw rows, 5 hidden exact copies -> 9 shown (5 primary + extra + 2 near misses + gap fill)
  SELECT count(*) INTO n FROM templates_dedup WHERE height = 975600 AND pool = 'tj-p1';
  ASSERT n = 9, format('tj-p1 rows shown at 975600: %s, want 9', n);
  SELECT string_agg(job_id || ':' || class, ',' ORDER BY job_id) INTO j FROM templates_copies
   WHERE height = 975600 AND pool = 'tj-p1';
  ASSERT j.string_agg = 'a-1:primary,a-2:primary,a-3:primary,a-4:primary,a-5:primary,b-1:copy,b-2:copy,b-3:copy,'
                        'b-4:copy,b-5:extra,b-6:near_miss,b-7:gap_fill,c-1:copy,c-2:near_miss',
         format('classes: %s', j.string_agg);

  -- a-1: first_seen from the earliest copy (s2/a), its own fields kept
  SELECT * INTO j FROM templates_dedup WHERE height = 975600 AND job_id = 'a-1';
  ASSERT j.first_seen = t0 + interval '0.001 s' AND j.received_at = t0 + interval '0.020 s', format('a-1 times %s', row_to_json(j));
  ASSERT j.copies = 3 AND j.replicas = ARRAY['a', 'b'] AND j.sites = ARRAY['s1', 's2'], format('a-1 copies %s', row_to_json(j));
  ASSERT j.coinbase1 = '\xa101' AND j.extranonce1 = '\xa1' AND j.site = 's1' AND j.replica = 'a' AND j.ntime = 1000,
         format('a-1 keeps its own fields: %s', row_to_json(j));
  -- a-2 (re-send, new ntime) is its own row; its copy is later, so no gain
  SELECT * INTO j FROM templates_dedup WHERE height = 975600 AND job_id = 'a-2';
  ASSERT j.copies = 2 AND j.first_seen = j.received_at AND j.ntime = 1030, format('a-2 %s', row_to_json(j));
  -- a template sent twice pairs one-to-one; the secondary's third copy is shown
  SELECT count(*) INTO n FROM templates_dedup WHERE height = 975600 AND job_id IN ('a-3', 'a-4') AND copies = 2;
  ASSERT n = 2, 'a-3 and a-4 each matched one copy';
  SELECT * INTO j FROM templates_dedup WHERE height = 975600 AND job_id = 'b-5';
  ASSERT FOUND AND NOT j.is_primary AND j.class = 'extra' AND j.copies = 1 AND j.replicas = ARRAY['b'], 'b-5 extra copy shown';
  SELECT count(*) INTO n FROM templates_dedup WHERE height = 975600 AND job_id IN ('b-6', 'c-2') AND class = 'near_miss' AND NOT is_primary;
  ASSERT n = 2, 'near misses shown';
  SELECT * INTO j FROM templates_dedup WHERE height = 975600 AND job_id = 'b-7';
  ASSERT FOUND AND j.class = 'gap_fill' AND j.first_seen = j.received_at, 'gap fill shown';
  -- another pool is never merged
  SELECT * INTO j FROM templates_dedup WHERE height = 975600 AND pool = 'tj-p2';
  ASSERT FOUND AND j.copies = 1 AND j.is_primary, 'tj-p2 kept';

  -- 975601: the usual primary has no rows there, so s1/b is the primary
  SELECT string_agg(job_id || ':' || class, ',' ORDER BY job_id) INTO j FROM templates_copies WHERE height = 975601;
  ASSERT j.string_agg = 'b-8:primary,b-9:primary,c-3:copy', format('975601 classes: %s', j.string_agg);

  -- ranges
  SELECT count(*) INTO n FROM templates_dedup WHERE height BETWEEN 975600 AND 975602 AND pool = 'tj-p1';
  ASSERT n = 12, format('tj-p1 rows shown in 975600..975602: %s, want 12', n);

  -- other chains
  SELECT string_agg(job_id || ':' || class, ',' ORDER BY job_id) INTO j FROM templates_other_copies WHERE height = 975600 AND pool = 'tj-p1';
  ASSERT j.string_agg = 'oa:primary,ob:copy,oc:near_miss', format('other classes: %s', j.string_agg);
  SELECT * INTO j FROM templates_other_dedup WHERE height = 975600 AND job_id = 'oa';
  ASSERT j.first_seen = t0 + interval '1 s' AND j.copies = 2 AND j.chain = 'bch' AND j.reason = 'bch', format('oa %s', row_to_json(j));

  -- three sites: one row per template, per-site receive times kept next to the cross-site first_seen
  SELECT string_agg(job_id || ':' || class, ',' ORDER BY job_id) INTO j FROM templates_copies WHERE height = 975600 AND pool = 'tj-p4';
  ASSERT j.string_agg = 'q1:primary,q2:copy,q3:copy,q4:gap_fill,q5:near_miss', format('tj-p4 classes: %s', j.string_agg);
  SELECT * INTO j FROM templates_dedup WHERE height = 975600 AND job_id = 'q1';
  ASSERT j.first_seen = t0 + interval '0.9 s' AND j.received_at = t0 + interval '1 s' AND j.copies = 3
         AND j.sites = ARRAY['s1', 's2', 's3'], format('q1 %s', row_to_json(j));
  ASSERT (j.site_first_seen->>'s1')::timestamptz = t0 + interval '1 s'
     AND (j.site_first_seen->>'s2')::timestamptz = t0 + interval '0.9 s'
     AND (j.site_first_seen->>'s3')::timestamptz = t0 + interval '1.2 s', format('q1 per-site times %s', j.site_first_seen);
  SELECT * INTO j FROM templates_dedup WHERE height = 975600 AND job_id = 'q4';
  ASSERT FOUND AND NOT j.is_primary AND j.sites = ARRAY['s3'] AND (j.site_first_seen->>'s3')::timestamptz = t0 + interval '5 s',
         format('q4 %s', row_to_json(j));
  SELECT * INTO j FROM templates_dedup WHERE height = 975600 AND job_id = 'a-1';
  ASSERT (j.site_first_seen->>'s1')::timestamptz = t0 + interval '0.010 s'
     AND (j.site_first_seen->>'s2')::timestamptz = t0 + interval '0.001 s', format('a-1 per-site times %s', j.site_first_seen);

  -- the report: pool totals (site IS NULL)
  SELECT * INTO j FROM template_dedup_report(t0, t0 + interval '2 days') WHERE pool = 'tj-p1' AND day = '2030-06-01' AND site IS NULL;
  ASSERT (j.primary_rows, j.secondary_rows, j.secondary_hidden, j.secondary_shown, j.extra_copies, j.near_misses, j.gap_fills)
         = (7::bigint, 10::bigint, 6::bigint, 4::bigint, 1::bigint, 2::bigint, 1::bigint), format('report day 1 counts: %s', row_to_json(j));
  ASSERT (j.near_miss_ntime_1s, j.near_miss_ntime_2s, j.near_miss_ntime_3s, j.near_miss_ntime_4_10s, j.near_miss_ntime_over_10s)
         = (1::bigint, 0::bigint, 1::bigint, 0::bigint, 0::bigint), format('report day 1 ntime differences: %s', row_to_json(j));
  ASSERT j.first_seen_gains = 1 AND abs(j.gain_ms_p50 - 19) < 1e-6 AND abs(j.gain_ms_max - 19) < 1e-6,
         format('report day 1 gains: %s', row_to_json(j));
  SELECT * INTO j FROM template_dedup_report(t0, t0 + interval '2 days') WHERE pool = 'tj-p1' AND day = '2030-06-02' AND site IS NULL;
  ASSERT (j.primary_rows, j.secondary_hidden, j.secondary_shown, j.first_seen_gains) = (1::bigint, 1::bigint, 0::bigint, 1::bigint)
         AND abs(j.gain_ms_max - 5) < 1e-6, format('report day 2: %s', row_to_json(j));
  SELECT * INTO j FROM template_dedup_report(t0, t0 + interval '2 days') WHERE pool = 'tj-p3' AND site IS NULL;
  ASSERT (j.primary_rows, j.secondary_rows, j.first_seen_gains) = (3::bigint, 0::bigint, 0::bigint) AND j.gain_ms_p50 IS NULL,
         format('report tj-p3: %s', row_to_json(j));
  SELECT count(*) INTO n FROM template_dedup_report(t0, t0 + interval '1 day') WHERE site IS NULL;
  ASSERT n = 4, format('report totals for day 1 only: %s (tj-p1 .. tj-p4)', n);
  -- per site: tj-p1's s1 (primary site; replica b's copy of a-1 was 10 ms earlier) and s2 (19 ms earlier)
  SELECT * INTO j FROM template_dedup_report(t0, t0 + interval '1 day') WHERE pool = 'tj-p1' AND site = 's1';
  ASSERT (j.rows, j.primary_rows, j.secondary_hidden, j.secondary_shown, j.first_seen_gains) = (14::bigint, 7::bigint, 4::bigint, 3::bigint, 1::bigint)
         AND abs(j.gain_ms_max - 10) < 1e-6, format('report tj-p1 s1: %s', row_to_json(j));
  SELECT * INTO j FROM template_dedup_report(t0, t0 + interval '1 day') WHERE pool = 'tj-p1' AND site = 's2';
  ASSERT (j.rows, j.primary_rows, j.secondary_hidden, j.near_misses, j.near_miss_ntime_1s, j.first_seen_gains)
         = (3::bigint, 0::bigint, 2::bigint, 1::bigint, 1::bigint, 1::bigint) AND abs(j.gain_ms_max - 19) < 1e-6,
         format('report tj-p1 s2: %s', row_to_json(j));
  -- three sites
  SELECT * INTO j FROM template_dedup_report(t0, t0 + interval '1 day') WHERE pool = 'tj-p4' AND site IS NULL;
  ASSERT (j.rows, j.primary_rows, j.secondary_rows, j.secondary_hidden, j.secondary_shown, j.near_misses, j.near_miss_ntime_2s,
          j.gap_fills, j.first_seen_gains) = (5::bigint, 1::bigint, 4::bigint, 2::bigint, 2::bigint, 1::bigint, 1::bigint, 1::bigint, 1::bigint)
         AND abs(j.gain_ms_max - 100) < 1e-6, format('report tj-p4 total: %s', row_to_json(j));
  SELECT * INTO j FROM template_dedup_report(t0, t0 + interval '1 day') WHERE pool = 'tj-p4' AND site = 's2';
  ASSERT (j.rows, j.secondary_hidden, j.near_misses, j.near_miss_ntime_2s, j.gap_fills, j.first_seen_gains)
         = (2::bigint, 1::bigint, 1::bigint, 1::bigint, 0::bigint, 1::bigint) AND abs(j.gain_ms_p50 - 100) < 1e-6,
         format('report tj-p4 s2: %s', row_to_json(j));
  SELECT * INTO j FROM template_dedup_report(t0, t0 + interval '1 day') WHERE pool = 'tj-p4' AND site = 's3';
  ASSERT (j.rows, j.secondary_hidden, j.near_misses, j.gap_fills, j.first_seen_gains) = (2::bigint, 1::bigint, 0::bigint, 1::bigint, 0::bigint),
         format('report tj-p4 s3: %s', row_to_json(j));
  SELECT * INTO j FROM template_dedup_report(t0, t0 + interval '1 day') WHERE pool = 'tj-p4' AND site = 's1';
  ASSERT (j.rows, j.primary_rows, j.secondary_rows) = (1::bigint, 1::bigint, 0::bigint), format('report tj-p4 s1: %s', row_to_json(j));
  SELECT count(*) INTO n FROM template_dedup_report(t0 - interval '10 days', t0 - interval '9 days');
  ASSERT n = 0, 'empty window, empty report';
END $$;

SET ROLE stratum_web;
SELECT pg_temp.tj_check();
RESET ROLE;
SET ROLE stratum_backend;
SELECT pg_temp.tj_check();
RESET ROLE;

ROLLBACK;
