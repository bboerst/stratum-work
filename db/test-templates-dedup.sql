-- De-duplicated reads (templates_copies / templates_dedup / template_dedup_report) on synthetic data: exact copies
-- (20261115000001_templates_dedup.sql) and one stream per pool (20261116200001_one_stream_per_pool.sql). Run by
-- db/test-migrations.sh as the superuser, in a transaction that is rolled back: inserts as the superuser, reads as
-- the web and backend roles. Any failed ASSERT aborts with an error.
--
-- Windows: a secondary row is hidden ('secondary_stream') when a lower-ranked source of the pool has a row at that
-- height within [received_at - 90 s, received_at + 10 s] (template_stream_silence / template_stream_lead).
BEGIN;

INSERT INTO sources (name, site, replica) VALUES
  ('tj-p1', 's1', 'a'), ('tj-p1', 's1', 'b'), ('tj-p1', 's2', 'a'),   -- ranks 1, 2, 3: primary s1/a
  ('tj-p2', 's1', 'a'),                                               -- single collector
  ('tj-p3', 's1', 'a'),                                               -- single collector, with re-sends
  ('tj-p4', 's1', 'a'), ('tj-p4', 's2', 'a'), ('tj-p4', 's3', 'a'),   -- three sites (regions); s1 is the primary
  ('tj-p5', 's1', 'b'), ('tj-p5', 's1', 'a');                         -- per-connection jobs (registered b first)

CREATE TEMP TABLE tj_src ON COMMIT DROP AS
  SELECT id, name || '/' || site || '/' || replica AS k FROM sources WHERE name LIKE 'tj-%';

-- (source, seconds after T0, height, job_id, branches byte, ntime, coinbase byte)
CREATE TEMP TABLE tj_rows ON COMMIT DROP AS SELECT * FROM (VALUES
  -- height 975600, tj-p1 primary (s1/a): job aa sent, then re-sent with a new ntime; template cc sent twice; job dd
  ('tj-p1/s1/a',  0.020, 975600, 'a-1', 'aa', 1000, 'a1'),
  ('tj-p1/s1/a', 30.000, 975600, 'a-2', 'aa', 1030, 'a2'),
  ('tj-p1/s1/a', 40.000, 975600, 'a-3', 'cc', 1100, 'a3'),
  ('tj-p1/s1/a', 41.000, 975600, 'a-4', 'cc', 1100, 'a4'),
  ('tj-p1/s1/a', 50.000, 975600, 'a-5', 'dd', 1200, 'a5'),   -- the primary's last row at this height
  -- secondary s1/b
  ('tj-p1/s1/b',  0.010, 975600, 'b-1', 'aa', 1000, 'b1'),   -- exact copy of a-1, 10 ms earlier: hidden ('copy')
  ('tj-p1/s1/b', 30.500, 975600, 'b-2', 'aa', 1030, 'b2'),   -- exact copy of a-2, later: 'copy'
  ('tj-p1/s1/b', 40.500, 975600, 'b-3', 'cc', 1100, 'b3'),   -- 1st copy of cc -> pairs with a-3: 'copy'
  ('tj-p1/s1/b', 41.200, 975600, 'b-4', 'cc', 1100, 'b4'),   -- 2nd copy -> pairs with a-4: 'copy'
  ('tj-p1/s1/b', 42.000, 975600, 'b-5', 'cc', 1100, 'b5'),   -- 3rd copy, a has two; a active: 'secondary_stream' (extra)
  ('tj-p1/s1/b', 50.100, 975600, 'b-6', 'dd', 1203, 'b6'),   -- job dd, ntime +3; a active: 'secondary_stream' (near miss)
  ('tj-p1/s1/b', 200.000, 975600, 'b-7', 'ee', 1300, 'b7'),  -- a silent for 150 s: shown ('gap_fill')
  -- secondary s2/a
  ('tj-p1/s2/a',  0.001, 975600, 'c-1', 'aa', 1000, 'c1'),   -- exact copy of a-1, earliest of all: 'copy'
  ('tj-p1/s2/a',  0.500, 975600, 'c-2', 'aa', 1001, 'c2'),   -- job aa, ntime 1001: 'secondary_stream' (near miss, 1 s)
  ('tj-p1/s2/a', 201.000, 975600, 'c-4', 'c4', 1301, 'c4'),  -- a silent, but b (rank 2) active: 'secondary_stream'
  ('tj-p1/s2/a', 400.000, 975600, 'c-5', 'c5', 1400, 'c5'),  -- a and b silent: 'gap_fill'
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
  -- tj-p4, three sites: one template seen everywhere at different times, others only at one site
  ('tj-p4/s1/a',  1.000, 975600, 'q1', '44', 2000, 'f1'),
  ('tj-p4/s2/a',  0.900, 975600, 'q2', '44', 2000, 'f2'),    -- exact copy, 100 ms before the primary: 'copy'
  ('tj-p4/s3/a',  1.200, 975600, 'q3', '44', 2000, 'f3'),    -- exact copy, later: 'copy'
  ('tj-p4/s3/a',  5.000, 975600, 'q4', '55', 2100, 'f4'),    -- only s3 has it, s1 active: 'secondary_stream'
  ('tj-p4/s2/a',  1.500, 975600, 'q5', '44', 2002, 'f5'),    -- same job, ntime +2: 'secondary_stream' (near miss, 2 s)
  ('tj-p4/s3/a', 200.000, 975600, 'q6', '66', 2200, 'f6')    -- s1 and s2 silent: 'gap_fill'
) v(k, s, height, job_id, br, ntime, cb);

-- tj-p5: a pool that gives each connection its own jobs (every row has its own merkle branches, so no exact copies).
--   975610  a every 30 s from 0 to 90, an outage, back at 400 / 430 / 460; b every 30 s from 5 to 455.
--           b is shown from 185 (a silent > 90 s) to 365; 395 is within 10 s of a's return, so hidden.
--   975611  new block: b's first job 50 ms before a's (both up): b hidden.
--   975612  a's first row of the height comes late (2065): b's 2000 and 2030 fill in, 2060 and 2090 are hidden.
INSERT INTO tj_rows
SELECT 'tj-p5/s1/a', v.s, v.height, 'a5-' || v.s, NULL, 5000 + v.s::int, '5a'
  FROM (VALUES (0.0, 975610), (30.0, 975610), (60.0, 975610), (90.0, 975610), (400.0, 975610), (430.0, 975610),
               (460.0, 975610), (1000.050, 975611), (1030.0, 975611), (2065.0, 975612), (2095.0, 975612)) v(s, height)
UNION ALL
SELECT 'tj-p5/s1/b', v.s, v.height, 'b5-' || v.s, NULL, 5000 + v.s::int, '5b'
  FROM (SELECT 5.0 + 30 * k, 975610 FROM generate_series(0, 15) k
        UNION ALL VALUES (1000.0, 975611), (1020.0, 975611), (2000.0, 975612), (2030.0, 975612), (2060.0, 975612),
                         (2090.0, 975612)) v(s, height);

INSERT INTO templates (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2, merkle_branches,
                       version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length, latency_ms, latency_method)
SELECT timestamptz '2030-06-01 00:00:00+00' + make_interval(secs => r.s), s.id, r.height, r.job_id,
       decode(repeat(to_hex(r.height % 256), 32), 'hex'), decode(r.cb || '01', 'hex'), decode(r.cb || '02', 'hex'),
       -- tj-p5 rows: branches unique per row (per-connection jobs)
       coalesce(decode(repeat(r.br, 64), 'hex'), sha256(convert_to(r.job_id, 'UTF8'))), 536870912, 386000000,
       r.ntime, true, decode(r.cb, 'hex'), 8, r.s, 'tcp'
  FROM tj_rows r JOIN tj_src s ON s.k = r.k;


CREATE FUNCTION pg_temp.tj_check() RETURNS void LANGUAGE plpgsql AS $$
DECLARE j record; n int; t0 timestamptz := '2030-06-01 00:00:00+00';
BEGIN
  ASSERT template_stream_silence() = interval '90 s' AND template_stream_lead() = interval '10 s', 'window constants';

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

  -- tj-p1 at 975600: 16 raw rows, 6 exact copies and 4 secondary-stream rows hidden -> 5 primary + 2 gap fills shown
  SELECT count(*) INTO n FROM templates_dedup WHERE height = 975600 AND pool = 'tj-p1';
  ASSERT n = 7, format('tj-p1 rows shown at 975600: %s, want 7', n);
  SELECT string_agg(job_id || ':' || class || ':' || coalesce(primary_match, '-'), ',' ORDER BY job_id) INTO j
    FROM templates_copies WHERE height = 975600 AND pool = 'tj-p1';
  ASSERT j.string_agg = 'a-1:primary:-,a-2:primary:-,a-3:primary:-,a-4:primary:-,a-5:primary:-,b-1:copy:copy,'
                        'b-2:copy:copy,b-3:copy:copy,b-4:copy:copy,b-5:secondary_stream:extra,'
                        'b-6:secondary_stream:near_miss,b-7:gap_fill:other_job,c-1:copy:copy,'
                        'c-2:secondary_stream:near_miss,c-4:secondary_stream:other_job,c-5:gap_fill:other_job',
         format('classes: %s', j.string_agg);
  SELECT string_agg(job_id || ':' || source_rank || ':' || active_rank, ',' ORDER BY job_id) INTO j
    FROM templates_copies WHERE height = 975600 AND job_id IN ('a-5', 'b-6', 'b-7', 'c-4', 'c-5');
  ASSERT j.string_agg = 'a-5:1:1,b-6:2:1,b-7:2:2,c-4:3:2,c-5:3:3', format('ranks: %s', j.string_agg);

  -- a-1: first_seen from the earliest copy (s2/a), its own fields kept
  SELECT * INTO j FROM templates_dedup WHERE height = 975600 AND job_id = 'a-1';
  ASSERT j.first_seen = t0 + interval '0.001 s' AND j.received_at = t0 + interval '0.020 s', format('a-1 times %s', row_to_json(j));
  ASSERT j.copies = 3 AND j.replicas = ARRAY['a', 'b'] AND j.sites = ARRAY['s1', 's2'], format('a-1 copies %s', row_to_json(j));
  ASSERT j.coinbase1 = '\xa101' AND j.extranonce1 = '\xa1' AND j.site = 's1' AND j.replica = 'a' AND j.ntime = 1000,
         format('a-1 keeps its own fields: %s', row_to_json(j));
  -- a-2 (re-send, new ntime) is its own row; its copy is later, so no gain
  SELECT * INTO j FROM templates_dedup WHERE height = 975600 AND job_id = 'a-2';
  ASSERT j.copies = 2 AND j.first_seen = j.received_at AND j.ntime = 1030, format('a-2 %s', row_to_json(j));
  -- a template sent twice pairs one-to-one; the secondary's third copy is hidden too (the primary was active)
  SELECT count(*) INTO n FROM templates_dedup WHERE height = 975600 AND job_id IN ('a-3', 'a-4') AND copies = 2;
  ASSERT n = 2, 'a-3 and a-4 each matched one copy';
  SELECT count(*) INTO n FROM templates_dedup WHERE height = 975600 AND job_id IN ('b-5', 'b-6', 'c-2', 'c-4');
  ASSERT n = 0, 'secondary-stream rows hidden';
  SELECT * INTO j FROM templates_dedup WHERE height = 975600 AND job_id = 'b-7';
  ASSERT FOUND AND NOT j.is_primary AND j.class = 'gap_fill' AND j.first_seen = j.received_at AND j.copies = 1
         AND j.replicas = ARRAY['b'], format('b-7 gap fill %s', row_to_json(j));
  SELECT * INTO j FROM templates_dedup WHERE height = 975600 AND job_id = 'c-5';
  ASSERT FOUND AND j.class = 'gap_fill' AND j.sites = ARRAY['s2'], 'c-5 gap fill';
  -- another pool is never merged
  SELECT * INTO j FROM templates_dedup WHERE height = 975600 AND pool = 'tj-p2';
  ASSERT FOUND AND j.copies = 1 AND j.is_primary, 'tj-p2 kept';

  -- 975601: the usual primary has no rows there, so s1/b is the primary
  SELECT string_agg(job_id || ':' || class, ',' ORDER BY job_id) INTO j FROM templates_copies WHERE height = 975601;
  ASSERT j.string_agg = 'b-8:primary,b-9:primary,c-3:copy', format('975601 classes: %s', j.string_agg);

  -- ranges (and the pool filter)
  SELECT count(*) INTO n FROM templates_dedup WHERE height BETWEEN 975600 AND 975602 AND pool = 'tj-p1';
  ASSERT n = 10, format('tj-p1 rows shown in 975600..975602: %s, want 10', n);

  -- per-connection jobs with an outage (tj-p5; registered b before a: the rank is by name, not by id)
  SELECT string_agg(to_char(extract(epoch FROM received_at - t0), 'FM9990'), ',' ORDER BY received_at) INTO j
    FROM templates_dedup WHERE height = 975610 AND pool = 'tj-p5' AND class = 'gap_fill';
  ASSERT j.string_agg = '185,215,245,275,305,335,365', format('tj-p5 gap fills: %s', j.string_agg);
  SELECT count(*) INTO n FROM templates_copies WHERE height = 975610 AND pool = 'tj-p5' AND class = 'secondary_stream';
  ASSERT n = 9, format('tj-p5 secondary-stream rows: %s, want 9', n);
  SELECT count(*) INTO n FROM templates_dedup WHERE height = 975610 AND pool = 'tj-p5' AND replica = 'a';
  ASSERT n = 7, 'tj-p5: every primary row shown';
  SELECT string_agg(replica || ':' || class, ',' ORDER BY received_at) INTO j FROM templates_copies WHERE height = 975611;
  ASSERT j.string_agg = 'b:secondary_stream,a:primary,b:secondary_stream,a:primary', format('975611 new block: %s', j.string_agg);
  SELECT string_agg(replica || ':' || class, ',' ORDER BY received_at) INTO j FROM templates_copies WHERE height = 975612;
  ASSERT j.string_agg = 'b:gap_fill,b:gap_fill,b:secondary_stream,a:primary,b:secondary_stream,a:primary',
         format('975612 primary late: %s', j.string_agg);

  -- three sites: one row per template, per-site receive times kept next to the cross-site first_seen
  SELECT string_agg(job_id || ':' || class, ',' ORDER BY job_id) INTO j FROM templates_copies WHERE height = 975600 AND pool = 'tj-p4';
  ASSERT j.string_agg = 'q1:primary,q2:copy,q3:copy,q4:secondary_stream,q5:secondary_stream,q6:gap_fill',
         format('tj-p4 classes: %s', j.string_agg);
  SELECT * INTO j FROM templates_dedup WHERE height = 975600 AND job_id = 'q1';
  ASSERT j.first_seen = t0 + interval '0.9 s' AND j.received_at = t0 + interval '1 s' AND j.copies = 3
         AND j.sites = ARRAY['s1', 's2', 's3'], format('q1 %s', row_to_json(j));
  ASSERT (j.site_first_seen->>'s1')::timestamptz = t0 + interval '1 s'
     AND (j.site_first_seen->>'s2')::timestamptz = t0 + interval '0.9 s'
     AND (j.site_first_seen->>'s3')::timestamptz = t0 + interval '1.2 s', format('q1 per-site times %s', j.site_first_seen);
  SELECT * INTO j FROM templates_dedup WHERE height = 975600 AND job_id = 'q6';
  ASSERT FOUND AND NOT j.is_primary AND j.sites = ARRAY['s3'] AND (j.site_first_seen->>'s3')::timestamptz = t0 + interval '200 s',
         format('q6 %s', row_to_json(j));
  SELECT * INTO j FROM templates_dedup WHERE height = 975600 AND job_id = 'a-1';
  ASSERT (j.site_first_seen->>'s1')::timestamptz = t0 + interval '0.010 s'
     AND (j.site_first_seen->>'s2')::timestamptz = t0 + interval '0.001 s', format('a-1 per-site times %s', j.site_first_seen);

  -- the report: pool totals (site IS NULL)
  SELECT * INTO j FROM template_dedup_report(t0, t0 + interval '2 days') WHERE pool = 'tj-p1' AND day = '2030-06-01' AND site IS NULL;
  ASSERT (j.rows, j.primary_rows, j.secondary_rows, j.secondary_hidden, j.exact_copies, j.secondary_stream, j.secondary_shown,
          j.gap_fills, j.extra_copies, j.near_misses)
         = (19::bigint, 7::bigint, 12::bigint, 10::bigint, 6::bigint, 4::bigint, 2::bigint, 2::bigint, 1::bigint, 2::bigint),
         format('report day 1 counts: %s', row_to_json(j));
  ASSERT (j.near_miss_ntime_1s, j.near_miss_ntime_2s, j.near_miss_ntime_3s, j.near_miss_ntime_4_10s, j.near_miss_ntime_over_10s)
         = (1::bigint, 0::bigint, 1::bigint, 0::bigint, 0::bigint), format('report day 1 ntime differences: %s', row_to_json(j));
  ASSERT j.first_seen_gains = 1 AND abs(j.gain_ms_p50 - 19) < 1e-6 AND abs(j.gain_ms_max - 19) < 1e-6,
         format('report day 1 gains: %s', row_to_json(j));
  SELECT * INTO j FROM template_dedup_report(t0, t0 + interval '2 days') WHERE pool = 'tj-p1' AND day = '2030-06-02' AND site IS NULL;
  ASSERT (j.primary_rows, j.secondary_hidden, j.exact_copies, j.secondary_shown, j.first_seen_gains)
         = (1::bigint, 1::bigint, 1::bigint, 0::bigint, 1::bigint) AND abs(j.gain_ms_max - 5) < 1e-6, format('report day 2: %s', row_to_json(j));
  SELECT * INTO j FROM template_dedup_report(t0, t0 + interval '2 days') WHERE pool = 'tj-p3' AND site IS NULL;
  ASSERT (j.primary_rows, j.secondary_rows, j.secondary_stream, j.first_seen_gains) = (3::bigint, 0::bigint, 0::bigint, 0::bigint)
         AND j.gain_ms_p50 IS NULL, format('report tj-p3: %s', row_to_json(j));
  SELECT count(*) INTO n FROM template_dedup_report(t0, t0 + interval '1 day') WHERE site IS NULL;
  ASSERT n = 5, format('report totals for day 1 only: %s (tj-p1 .. tj-p5)', n);
  -- per site: tj-p1's s1 (primary site; replica b's copy of a-1 was 10 ms earlier) and s2 (19 ms earlier)
  SELECT * INTO j FROM template_dedup_report(t0, t0 + interval '1 day') WHERE pool = 'tj-p1' AND site = 's1';
  ASSERT (j.rows, j.primary_rows, j.secondary_hidden, j.exact_copies, j.secondary_stream, j.secondary_shown, j.first_seen_gains)
         = (14::bigint, 7::bigint, 6::bigint, 4::bigint, 2::bigint, 1::bigint, 1::bigint)
         AND abs(j.gain_ms_max - 10) < 1e-6, format('report tj-p1 s1: %s', row_to_json(j));
  SELECT * INTO j FROM template_dedup_report(t0, t0 + interval '1 day') WHERE pool = 'tj-p1' AND site = 's2';
  ASSERT (j.rows, j.primary_rows, j.secondary_hidden, j.exact_copies, j.secondary_stream, j.gap_fills, j.near_misses,
          j.near_miss_ntime_1s, j.first_seen_gains)
         = (5::bigint, 0::bigint, 4::bigint, 2::bigint, 2::bigint, 1::bigint, 1::bigint, 1::bigint, 1::bigint)
         AND abs(j.gain_ms_max - 19) < 1e-6, format('report tj-p1 s2: %s', row_to_json(j));
  -- three sites
  SELECT * INTO j FROM template_dedup_report(t0, t0 + interval '1 day') WHERE pool = 'tj-p4' AND site IS NULL;
  ASSERT (j.rows, j.primary_rows, j.secondary_rows, j.secondary_hidden, j.exact_copies, j.secondary_stream, j.secondary_shown,
          j.near_misses, j.near_miss_ntime_2s, j.gap_fills, j.first_seen_gains)
         = (6::bigint, 1::bigint, 5::bigint, 4::bigint, 2::bigint, 2::bigint, 1::bigint, 1::bigint, 1::bigint, 1::bigint, 1::bigint)
         AND abs(j.gain_ms_max - 100) < 1e-6, format('report tj-p4 total: %s', row_to_json(j));
  SELECT * INTO j FROM template_dedup_report(t0, t0 + interval '1 day') WHERE pool = 'tj-p4' AND site = 's2';
  ASSERT (j.rows, j.secondary_hidden, j.secondary_stream, j.near_misses, j.near_miss_ntime_2s, j.gap_fills, j.first_seen_gains)
         = (2::bigint, 2::bigint, 1::bigint, 1::bigint, 1::bigint, 0::bigint, 1::bigint) AND abs(j.gain_ms_p50 - 100) < 1e-6,
         format('report tj-p4 s2: %s', row_to_json(j));
  SELECT * INTO j FROM template_dedup_report(t0, t0 + interval '1 day') WHERE pool = 'tj-p4' AND site = 's3';
  ASSERT (j.rows, j.secondary_hidden, j.secondary_stream, j.near_misses, j.gap_fills, j.first_seen_gains)
         = (3::bigint, 2::bigint, 1::bigint, 0::bigint, 1::bigint, 0::bigint), format('report tj-p4 s3: %s', row_to_json(j));
  SELECT * INTO j FROM template_dedup_report(t0, t0 + interval '1 day') WHERE pool = 'tj-p4' AND site = 's1';
  ASSERT (j.rows, j.primary_rows, j.secondary_rows) = (1::bigint, 1::bigint, 0::bigint), format('report tj-p4 s1: %s', row_to_json(j));
  -- per-connection jobs: no exact copies, the secondary's stream hidden while the primary is up, gap fills counted
  SELECT * INTO j FROM template_dedup_report(t0, t0 + interval '1 day') WHERE pool = 'tj-p5' AND site IS NULL;
  ASSERT (j.rows, j.primary_rows, j.secondary_rows, j.exact_copies, j.secondary_stream, j.secondary_hidden, j.gap_fills,
          j.secondary_shown, j.near_misses, j.extra_copies)
         = (33::bigint, 11::bigint, 22::bigint, 0::bigint, 13::bigint, 13::bigint, 9::bigint, 9::bigint, 0::bigint, 0::bigint),
         format('report tj-p5: %s', row_to_json(j));
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
