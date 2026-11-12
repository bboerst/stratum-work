SET timescaledb.enable_chunk_skipping = on;
ANALYZE templates; ANALYZE templates_other;
CREATE OR REPLACE FUNCTION median_ms(q text, runs int DEFAULT 7) RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE t numeric[] := '{}'; p jsonb; BEGIN
  FOR i IN 1..runs LOOP EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) ' || q INTO p; t := t || (p->0->>'Execution Time')::numeric; END LOOP;
  RETURN round((SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x) FROM unnest(t) x)::numeric, 2); END $$;
\pset format unaligned
\pset fieldsep '|'
\pset tuples_only on
SELECT 'R1 templates at height (BTC)', median_ms($q$SELECT * FROM templates WHERE height = 975439$q$), (SELECT count(*) FROM templates WHERE height = 975439);
SELECT 'R2 + other chains at height (3 cols)', median_ms($q$SELECT received_at, source_id, height FROM templates WHERE height = 975439 UNION ALL SELECT received_at, source_id, height FROM templates_other WHERE height = 975439$q$), (SELECT count(*) FROM templates WHERE height = 975439) + (SELECT count(*) FROM templates_other WHERE height = 975439);
SELECT 'R4 first-seen per source', median_ms($q$SELECT DISTINCT ON (source_id) source_id, received_at, latency_ms FROM templates WHERE height = 975439 ORDER BY source_id, received_at$q$), (SELECT count(DISTINCT source_id) FROM templates WHERE height = 975439);
SELECT 'R4b reliability (#104): sources at h-1', median_ms($q$SELECT DISTINCT source_id FROM templates WHERE height = 975438$q$), 0;
SELECT 'R3 interesting blocks (latest 200)', median_ms($q$SELECT height, block_hash, analysis FROM blocks WHERE (analysis - 'pool_identification') <> '{}'::jsonb ORDER BY height DESC LIMIT 200$q$), (SELECT count(*) FROM blocks WHERE (analysis - 'pool_identification') <> '{}'::jsonb);
SELECT 'R5 latest 20 blocks', median_ms($q$SELECT * FROM blocks ORDER BY height DESC LIMIT 21$q$), 21;
SELECT 'R5b 40 blocks around a height', median_ms($q$SELECT * FROM blocks WHERE height BETWEEN 975419 AND 975459 ORDER BY height DESC$q$), (SELECT count(*) FROM blocks WHERE height BETWEEN 975419 AND 975459);
SELECT 'R6 block by height', median_ms($q$SELECT * FROM blocks WHERE height = 975439$q$), (SELECT count(*) FROM blocks WHERE height = 975439);
SELECT 'time window: 1 source, last 6h', median_ms($q$SELECT count(*) FROM templates WHERE source_id = 3 AND received_at > (SELECT max(received_at) FROM templates) - interval '6 hours'$q$), 0;
SELECT 'cross-pool: identical branch sets at a height', median_ms($q$SELECT merkle_branches, count(DISTINCT source_id) FROM templates WHERE height = 975439 GROUP BY 1 HAVING count(DISTINCT source_id) > 1$q$), (SELECT count(*) FROM (SELECT merkle_branches FROM templates WHERE height = 975439 GROUP BY 1 HAVING count(DISTINCT source_id) > 1) x);
