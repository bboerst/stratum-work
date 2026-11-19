#!/usr/bin/env bash
# Test the dbmate migrations end to end: up -> down (to zero) -> up, plus role privileges, against a throwaway
# TimescaleDB. Needs Docker.
#
#   db/test-migrations.sh                      # official timescale/timescaledb image (what local dev uses)
#   db/test-migrations.sh --image <cnpg-image> # e.g. a locally built postgres/Dockerfile (CNPG layout)
set -uo pipefail
cd "$(dirname "$0")/.."
DBMATE=ghcr.io/amacneil/dbmate:2.37.0
IMAGE=timescale/timescaledb:2.30.2-pg18; CNPG=0
if [ "${1:-}" = "--image" ]; then IMAGE=$2; CNPG=1; fi
NET=mig-test-$$; PG=mig-pg-$$
ok=0; bad=0; check() { if eval "$2" >/dev/null 2>&1; then echo "  PASS  $1"; ok=$((ok+1)); else echo "  FAIL  $1"; bad=$((bad+1)); fi; }
cleanup() { docker rm -fv "$PG" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
trap cleanup EXIT

docker network create "$NET" >/dev/null
if [ "$CNPG" = 1 ]; then
  # CNPG operand images have no entrypoint: initialise and start postgres like the operator would.
  docker run -d --name "$PG" --network "$NET" --entrypoint bash "$IMAGE" -c '
    initdb -D /tmp/pg -U postgres -A trust >/dev/null &&
    echo "listen_addresses = '"'"'*'"'"'" >> /tmp/pg/postgresql.conf &&
    echo "host all all 0.0.0.0/0 trust" >> /tmp/pg/pg_hba.conf &&
    exec postgres -D /tmp/pg -c shared_preload_libraries=timescaledb -c timescaledb.enable_chunk_skipping=on' >/dev/null
else
  docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD=test "$IMAGE" -c timescaledb.enable_chunk_skipping=on >/dev/null
fi
for i in $(seq 60); do docker exec "$PG" pg_isready -h localhost -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
URL="postgres://postgres:test@$PG:5432/postgres?sslmode=disable"
dbmate() { docker run --rm --network "$NET" -v "$PWD/db:/db" -e DATABASE_URL="$URL" -e DBMATE_NO_DUMP_SCHEMA=true "$DBMATE" --wait "$@"; }
psql_() { docker exec "$PG" psql -h localhost -U postgres -v ON_ERROR_STOP=1 -At -c "$1"; }
as_user() { docker exec "$PG" psql -h localhost -U "$1" -d postgres -v ON_ERROR_STOP=1 -At -c "$2"; }

echo "== image: $IMAGE"
check "migrate up (all)"                 'dbmate up'
check "timescaledb loaded"               '[ -n "$(psql_ "SELECT extversion FROM pg_extension WHERE extname = '"'"'timescaledb'"'"'")" ]'
check "templates, mempool_txs, _tx_inputs, _tx_raw, clock_samples: hypertables with columnstore" '[ "$(psql_ "SELECT count(*) FROM timescaledb_information.hypertables WHERE compression_enabled")" = 5 ]'
check "chunk skipping on templates.height" '[ "$(psql_ "SELECT count(*) FROM _timescaledb_catalog.chunk_column_stats WHERE column_name = '"'"'height'"'"'")" -ge 1 ]'
check "5 columnstore policy jobs"        '[ "$(psql_ "SELECT count(*) FROM timescaledb_information.jobs WHERE proc_name = '"'"'policy_compression'"'"'")" = 5 ]'
check "retention: inputs 30 days, raw 14 days" '[ "$(psql_ "SELECT string_agg(hypertable_name || '"'"'='"'"'|| (config->>'"'"'drop_after'"'"'), '"'"','"'"' ORDER BY hypertable_name) FROM timescaledb_information.jobs WHERE proc_name = '"'"'policy_retention'"'"'")" = "mempool_tx_inputs=30 days,mempool_tx_raw=14 days" ]'
check "all migrations recorded"        '[ "$(psql_ "SELECT count(*) FROM schema_migrations")" = 27 ]'
check "blocks.seen_via: zmq / reconcile / NULL only" 'psql_ "INSERT INTO blocks (block_hash, height, block_time, coinbase_script_sig, seen_via) VALUES (decode('"'"'01'"'"', '"'"'hex'"'"'), 1, now(), decode('"'"'00'"'"', '"'"'hex'"'"'), '"'"'zmq'"'"')" && ! psql_ "INSERT INTO blocks (block_hash, height, block_time, coinbase_script_sig, seen_via) VALUES (decode('"'"'02'"'"', '"'"'hex'"'"'), 1, now(), decode('"'"'00'"'"', '"'"'hex'"'"'), '"'"'rpc'"'"')" && psql_ "DELETE FROM blocks WHERE height = 1"'
check "ingest_events: start + session kinds" 'psql_ "INSERT INTO sources (name, site) VALUES ('"'"'kind-test'"'"', '"'"'t'"'"')" && psql_ "INSERT INTO ingest_events (source_id, kind, started_at, ended_at, templates) SELECT id, '"'"'start'"'"', now(), now(), 0 FROM sources LIMIT 1" && psql_ "INSERT INTO ingest_events (source_id, kind, started_at, ended_at, templates) SELECT id, '"'"'session'"'"', now(), now(), 0 FROM sources LIMIT 1" && ! psql_ "INSERT INTO ingest_events (source_id, kind, started_at, ended_at, templates) SELECT id, '"'"'reboot'"'"', now(), now(), 0 FROM sources LIMIT 1" && psql_ "DELETE FROM ingest_events; DELETE FROM sources WHERE name = '"'"'kind-test'"'"'"'
check "mempool_tx_inputs indexed by prevout" '[ "$(psql_ "SELECT count(*) FROM pg_indexes WHERE indexname = '"'"'mempool_tx_inputs_prevout'"'"'")" = 1 ]'

# role privileges: create login users the way an environment would
psql_ "CREATE USER t_collector LOGIN PASSWORD 'x' IN ROLE stratum_collector; CREATE USER t_backend LOGIN PASSWORD 'x' IN ROLE stratum_backend; CREATE USER t_web LOGIN PASSWORD 'x' IN ROLE stratum_web;" >/dev/null
INS="INSERT INTO templates (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2, merkle_branches, version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length) SELECT now(), id, 975500, 'j', '\\x00', '\\x01', '\\x02', '', 1, 2, 3, true, '\\x03', 8 FROM sources LIMIT 1"
check "collector: register a source"     'as_user t_collector "INSERT INTO sources (name, site) VALUES ('"'"'p1'"'"', '"'"'local'"'"')"'
check "collector: insert a template"     'as_user t_collector "$INS"'
UPSERT="INSERT INTO sources (name, site, replica, stratum_url) VALUES ('p1', 'local', 'b', 'stratum+tcp://x:1') ON CONFLICT (name, site, replica) DO UPDATE SET stratum_url = EXCLUDED.stratum_url RETURNING id"
check "sources: existing source is replica a" '[ "$(psql_ "SELECT replica FROM sources WHERE name = '"'"'p1'"'"'")" = a ]'
check "collector: upsert a second replica" 'as_user t_collector "$UPSERT"'
check "collector: upsert is idempotent"  '[ "$(as_user t_collector "$UPSERT")" = "$(as_user t_collector "$UPSERT")" ] && [ "$(psql_ "SELECT count(*) FROM sources WHERE name = '"'"'p1'"'"'")" = 2 ]'
check "sources: (name, site, replica) is unique" '! as_user t_collector "INSERT INTO sources (name, site) VALUES ('"'"'p1'"'"', '"'"'local'"'"')"'
check "sources: empty replica rejected"  '! psql_ "INSERT INTO sources (name, site, replica) VALUES ('"'"'p2'"'"', '"'"'local'"'"', '"'"''"'"')"'
REJ="INSERT INTO templates_rejected (received_at, source_id, stage, reason, raw_length, raw) SELECT now(), id, 'json', 'invalid JSON', 3, '\\x7b7b7b' FROM sources LIMIT 1"
check "collector: quarantine a message"  'as_user t_collector "$REJ"'
check "collector: cannot read quarantine" '! as_user t_collector "SELECT 1 FROM templates_rejected"'
check "backend: read quarantine"         '[ "$(as_user t_backend "SELECT count(*) FROM templates_rejected")" = 1 ]'
check "web: no quarantine access"        '! as_user t_web "SELECT 1 FROM templates_rejected"'
check "quarantine: unknown stage rejected" '! psql_ "INSERT INTO templates_rejected (received_at, source_id, stage, reason, raw_length) SELECT now(), id, '"'"'other'"'"', '"'"'x'"'"', 0 FROM sources LIMIT 1"'
EV="INSERT INTO ingest_events (source_id, kind, started_at, ended_at, templates, peak_per_second, detail) SELECT id, 'burst', now(), now(), 3000, 2500, '{\"per_second\": [500, 2500]}' FROM sources LIMIT 1"
check "collector: record an ingest event" 'as_user t_collector "$EV"'
check "collector: cannot read events"    '! as_user t_collector "SELECT 1 FROM ingest_events"'
check "backend: read events"             '[ "$(as_user t_backend "SELECT detail->'"'"'per_second'"'"'->>1 FROM ingest_events")" = 2500 ]'
check "web: no event access"             '! as_user t_web "SELECT 1 FROM ingest_events"'
check "events: end before start rejected" '! psql_ "INSERT INTO ingest_events (source_id, kind, started_at, ended_at, templates) SELECT id, '"'"'burst'"'"', now(), now() - interval '"'"'1 s'"'"', 1 FROM sources LIMIT 1"'
check "collector: cannot read blocks"    '! as_user t_collector "SELECT 1 FROM blocks"'
check "collector: cannot delete templates" '! as_user t_collector "DELETE FROM templates"'
check "backend: read templates"          '[ "$(as_user t_backend "SELECT count(*) FROM templates")" = 1 ]'
check "backend: write blocks"            'as_user t_backend "INSERT INTO blocks (block_hash, height, block_time, coinbase_script_sig) VALUES ('"'"'\\x01'"'"', 975499, now(), '"'"'\\x00'"'"')"'
check "backend: cannot write templates"  '! as_user t_backend "$INS"'
check "web: read blocks"                 '[ "$(as_user t_web "SELECT count(*) FROM blocks")" = 1 ]'
check "web: cannot write anything"       '! as_user t_web "INSERT INTO pools (id, name) VALUES (1, '"'"'x'"'"')"'
check "web: no DDL"                      '! as_user t_web "CREATE TABLE x (i int)"'
check "web: read the de-duplicated functions" 'as_user t_web "SELECT count(*) FROM templates_dedup(975500, 975500, '"'"'-infinity'"'"', '"'"'infinity'"'"') WHERE true; SELECT count(*) FROM templates_copies(975500, 975500, '"'"'-infinity'"'"', '"'"'infinity'"'"') WHERE true"'
check "backend: read the de-duplicated function" '[ "$(as_user t_backend "SELECT copies FROM templates_dedup(975500, 975500, '"'"'-infinity'"'"', '"'"'infinity'"'"') WHERE true")" = 1 ]'
check "collector: cannot call the read functions"  '! as_user t_collector "SELECT 1 FROM templates_dedup(975500, 975500, '"'"'-infinity'"'"', '"'"'infinity'"'"') WHERE true"'
check "dedup: synthetic replicas, sites and report" 'docker exec -i "$PG" psql -h localhost -U postgres -v ON_ERROR_STOP=1 -q < db/test-templates-dedup.sql'
# mempool recorder (mempool-recorder/): its own tables only; backend and web read them
psql_ "CREATE USER t_mempool LOGIN PASSWORD 'x' IN ROLE stratum_mempool" >/dev/null
psql_ "CREATE USER t_clock LOGIN PASSWORD 'x' IN ROLE stratum_clock" >/dev/null
check "clock: insert a sample, again is a no-op" 'as_user t_clock "INSERT INTO clock_samples (node, sampled_at, system_time_s, root_delay_s, root_dispersion_s, stratum, reference) VALUES ('"'"'n1'"'"', '"'"'2026-11-18 03:00Z'"'"', 0.0002, 0.009, 0.0003, 2, '"'"'192.0.2.1'"'"') ON CONFLICT DO NOTHING" && as_user t_clock "INSERT INTO clock_samples (node, sampled_at, system_time_s, root_delay_s, root_dispersion_s, stratum, reference) VALUES ('"'"'n1'"'"', '"'"'2026-11-18 03:00Z'"'"', 0.0002, 0.009, 0.0003, 2, '"'"'192.0.2.1'"'"') ON CONFLICT DO NOTHING" && [ "$(psql_ "SELECT count(*) FROM clock_samples")" = 1 ]'
check "clock: no other access"            '! as_user t_clock "SELECT 1 FROM clock_samples" && ! as_user t_clock "SELECT 1 FROM templates" && ! as_user t_clock "DELETE FROM clock_samples"'
check "web + backend: read clock samples" '[ "$(as_user t_web "SELECT round(((abs(system_time_s) + root_dispersion_s + root_delay_s / 2) * 1000)::numeric, 1) FROM clock_samples")" = 5.0 ] && as_user t_backend "SELECT 1 FROM clock_samples"'
check "collector: no clock access"        '! as_user t_collector "SELECT 1 FROM clock_samples"'
G=4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b  # genesis coinbase txid, display order
check "txid byte order: internal bytes are the reversed display hex" '[ "$(psql_ "SELECT encode(hash_from_display('"'"'$G'"'"'), '"'"'hex'"'"')")" = 3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a ] && [ "$(psql_ "SELECT hash_display(hash_from_display('"'"'$G'"'"'))")" = $G ]'
MTX="INSERT INTO mempool_txs (first_seen, first_seen_src, txid, input_count) VALUES (now() - interval '1 minute', 'zmq', hash_from_display('$G'), 1)"
MIN="INSERT INTO mempool_tx_inputs (first_seen, txid, n, prevout_txid, prevout_vout) SELECT first_seen, txid, 0, decode(repeat('22', 32), 'hex'), 4294967296 FROM mempool_txs"
check "mempool: insert a tx"             'as_user t_mempool "$MTX"'
check "mempool: same txid + first_seen is unique" '! as_user t_mempool "INSERT INTO mempool_txs (first_seen, first_seen_src, txid) SELECT first_seen, '"'"'zmq'"'"', txid FROM mempool_txs"'
check "mempool: prevout_vout is a u32" '! as_user t_mempool "$MIN"'
check "mempool: insert + read back an input" 'as_user t_mempool "${MIN/4294967296/3}" && [ "$(as_user t_mempool "SELECT prevout_vout FROM mempool_tx_inputs i JOIN mempool_txs t USING (txid, first_seen) WHERE t.removed_at IS NULL")" = 3 ]'
check "mempool: (txid, first_seen, n) is unique" '! as_user t_mempool "${MIN/4294967296/3}"'
check "mempool: cannot delete inputs"    '! as_user t_mempool "DELETE FROM mempool_tx_inputs"'
check "mempool: close it (update)"       'as_user t_mempool "UPDATE mempool_txs SET removed_at = now(), removal = '"'"'mined'"'"', removed_src = '"'"'zmq'"'"' WHERE txid = hash_from_display('"'"'$G'"'"')"'
check "mempool: removal needs all three columns" '! psql_ "UPDATE mempool_txs SET removal = NULL"'
check "mempool: removed before first_seen rejected" '! psql_ "UPDATE mempool_txs SET removed_at = first_seen - interval '"'"'1 s'"'"'"'
check "mempool: snapshot query (alive at t)" '[ "$(as_user t_web "SELECT count(*) FROM mempool_txs WHERE tstzrange(first_seen, removed_at, '"'"'[)'"'"') @> now() - interval '"'"'30 s'"'"'")" = 1 ]'
check "mempool: txid lookup from merkle_branches[0] bytes" '[ "$(as_user t_backend "SELECT removal FROM mempool_txs WHERE txid = substring(decode('"'"'3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a'"'"' || repeat('"'"'00'"'"', 32), '"'"'hex'"'"') from 1 for 32)")" = mined ]'
check "mempool: blocks and off-mempool rows" 'as_user t_mempool "INSERT INTO mempool_blocks (seen_at, block_hash, height, event) VALUES (now(), decode(repeat('"'"'00'"'"', 32), '"'"'hex'"'"'), 1, '"'"'connect'"'"'); INSERT INTO mempool_offmempool (block_hash, seen_at, txid, position) VALUES (decode(repeat('"'"'00'"'"', 32), '"'"'hex'"'"'), now(), decode(repeat('"'"'11'"'"', 32), '"'"'hex'"'"'), 1); INSERT INTO mempool_tx_raw (first_seen, txid, raw) VALUES (now(), decode(repeat('"'"'11'"'"', 32), '"'"'hex'"'"'), '"'"'\\x00'"'"'); SELECT block_hash FROM mempool_blocks"'
check "mempool: cannot delete its rows"  '! as_user t_mempool "DELETE FROM mempool_txs"'
check "mempool: cannot read templates"   '! as_user t_mempool "SELECT 1 FROM templates"'
check "mempool: cannot write blocks"     '! as_user t_mempool "INSERT INTO blocks (block_hash, height, block_time, coinbase_script_sig) VALUES ('"'"'\\x02'"'"', 1, now(), '"'"'\\x00'"'"')"'
check "mempool: cannot read raw / off-mempool back" '! as_user t_mempool "SELECT 1 FROM mempool_tx_raw" && ! as_user t_mempool "SELECT 1 FROM mempool_offmempool"'
check "web + backend: read the mempool tables" 'as_user t_web "SELECT count(*) FROM mempool_txs, mempool_tx_inputs, mempool_blocks, mempool_offmempool, mempool_tx_raw" && as_user t_backend "SELECT count(*) FROM mempool_txs, mempool_tx_inputs, mempool_blocks, mempool_offmempool, mempool_tx_raw"'
check "web: cannot write inputs"         '! as_user t_web "${MIN/4294967296/5}"'
check "web: cannot write the mempool tables" '! as_user t_web "$MTX"'
check "collector: no mempool access"     '! as_user t_collector "SELECT 1 FROM mempool_txs" && ! as_user t_collector "$MTX" && ! as_user t_collector "SELECT 1 FROM mempool_tx_inputs"'
check "mempool: bloom sparse index after compression" '[ "$(psql_ "SELECT count(compress_chunk(c)) FROM show_chunks('"'"'mempool_txs'"'"') c")" -ge 1 ] && [ "$(as_user t_backend "SELECT removal FROM mempool_txs WHERE txid = hash_from_display('"'"'$G'"'"')")" = mined ] && psql_ "EXPLAIN SELECT 1 FROM mempool_txs WHERE txid = hash_from_display('"'"'$G'"'"')" | grep -q bloom'
check "backend: write stale blocks + reorgs" 'as_user t_backend "INSERT INTO chain_reorgs (fork_height, depth, old_tip_hash, old_tip_height, new_tip_hash, new_tip_height) VALUES (1, 1, '"'"'\\x01'"'"', 2, '"'"'\\x02'"'"', 2); INSERT INTO stale_blocks (block_hash, height, prev_hash, version, block_time, bits, nonce, merkle_root, chaintip_status, last_status, tip_hash, fork_height) VALUES ('"'"'\\x0a'"'"', 2, '"'"'\\x01'"'"', 1, now(), 1, 1, '"'"'\\x00'"'"', '"'"'valid-fork'"'"', '"'"'valid-fork'"'"', '"'"'\\x0a'"'"', 1); UPDATE stale_blocks SET last_status = '"'"'active'"'"' WHERE height = 2"'
check "web: read stale blocks + stale-tip read" '[ "$(as_user t_web "SELECT count(*) FROM stale_blocks")" = 1 ] && as_user t_web "SELECT count(*) FROM stale_tip_templates(975500, 975501)"'
check "web: cannot write stale blocks"   '! as_user t_web "DELETE FROM stale_blocks"'
check "collector: no stale-block access" '! as_user t_collector "SELECT 1 FROM stale_blocks" && ! as_user t_collector "SELECT * FROM stale_tip_templates(1, 2)"'
check "stale: unknown chaintip status rejected" '! psql_ "UPDATE stale_blocks SET last_status = '"'"'other'"'"'"'
check "stale: header_source defaults to node; dataset rows with not-in-node allowed; other sources rejected" '[ "$(psql_ "SELECT header_source FROM stale_blocks")" = node ] && as_user t_backend "INSERT INTO stale_blocks (block_hash, height, prev_hash, version, block_time, bits, nonce, merkle_root, chaintip_status, last_status, tip_hash, fork_height, header_source) VALUES ('"'"'\\x0b'"'"', 2, '"'"'\\x01'"'"', 1, now(), 1, 1, '"'"'\\x00'"'"', '"'"'not-in-node'"'"', '"'"'not-in-node'"'"', '"'"'\\x0b'"'"', 1, '"'"'bitcoin-data/stale-blocks'"'"')" && ! psql_ "UPDATE stale_blocks SET header_source = '"'"'other'"'"'" && psql_ "DELETE FROM stale_blocks WHERE block_hash = '"'"'\\x0b'"'"'"'
psql_ "DELETE FROM stale_blocks; DELETE FROM chain_reorgs" >/dev/null
check "one table reads: windows, bounded dedup = views, stale filter, inlined, stale tips (synthetic)" 'docker exec -i "$PG" psql -h localhost -U postgres -v ON_ERROR_STOP=1 -q < db/test-one-table-reads.sql'
check "stale blocks: synthetic best / stale / unknown tips" 'docker exec -i "$PG" psql -h localhost -U postgres -v ON_ERROR_STOP=1 -q < db/test-stale-blocks.sql'
check "web + backend: read template_routing_labels; collector cannot" 'as_user t_web "SELECT count(*) FROM template_routing_labels" && as_user t_backend "SELECT count(*) FROM template_routing_labels" && ! as_user t_collector "SELECT 1 FROM template_routing_labels"'
check "web: cannot write template_routing_labels" '! as_user t_web "DELETE FROM template_routing_labels"'
check "web + backend: call block_template_matches" 'as_user t_web "SELECT count(*) FROM block_template_matches(975500, 975500)" && as_user t_backend "SELECT count(*) FROM block_template_matches(975500, 975500)"'
check "collector: cannot call block_template_matches" '! as_user t_collector "SELECT 1 FROM block_template_matches(975500, 975500)"'
check "web + backend: read blocks_best"   'as_user t_web "SELECT count(*) FROM blocks_best" && as_user t_backend "SELECT count(*) FROM blocks_best"'
check "collector: cannot read blocks_best" '! as_user t_collector "SELECT 1 FROM blocks_best"'
check "web: cannot write blocks_best"    '! as_user t_web "DELETE FROM blocks_best"'
check "blocks_best: stale hidden, active again shown" 'docker exec -i "$PG" psql -h localhost -U postgres -v ON_ERROR_STOP=1 -q < db/test-blocks-best.sql'
check "block_template_matches: full / shared set / partial depth / empty block (synthetic block)" 'docker exec -i "$PG" psql -h localhost -U postgres -v ON_ERROR_STOP=1 -q < db/test-block-template-matches.sql'
check "blocks_best shows the columns added after it (seen_via, merkle_branches)" '[ "$(psql_ "SELECT count(*) FROM information_schema.columns WHERE table_name = '"'"'blocks_best'"'"' AND column_name IN ('"'"'seen_via'"'"', '"'"'merkle_branches'"'"', '"'"'coinbase_txid'"'"', '"'"'coinbase_tx'"'"')")" = 4 ]'
check "blocks.merkle_branches: whole 32-byte branches only" '! psql_ "UPDATE blocks SET merkle_branches = decode('"'"'00'"'"', '"'"'hex'"'"')"'
UPP="INSERT INTO unknown_parent_pools (prev_hash, pool, n, first_received, last_received, auxpow, conns, heights, nbits) VALUES ('\\x01', 'p1', 1, now(), now(), 0, '{1}', '{}', '{}')"
check "backend: write unknown_parent_pools (insert, update, delete)" 'as_user t_backend "$UPP" && as_user t_backend "UPDATE unknown_parent_pools SET n = 2" && [ "$(as_user t_backend "SELECT n FROM unknown_parent_pools")" = 2 ] && as_user t_backend "DELETE FROM unknown_parent_pools"'
check "backend: recompute a parent (unknown_parent_pools_refresh)" '[ "$(as_user t_backend "SELECT unknown_parent_pools_refresh(prev_hash, ARRAY[975500], now() - interval '"'"'1 day'"'"', now() + interval '"'"'1 day'"'"') FROM templates LIMIT 1")" = 1 ] && [ "$(as_user t_web "SELECT n || '"'"':'"'"' || pool || '"'"':'"'"' || conns::text || '"'"':'"'"' || heights::text FROM unknown_parent_pools")" = '"'"'1:p1:{1}:{"975500": 1}'"'"' ] && psql_ "DELETE FROM unknown_parent_pools"'
check "web: read unknown_parent_pools, nothing else" 'as_user t_web "SELECT count(*) FROM unknown_parent_pools" && ! as_user t_web "$UPP" && ! as_user t_web "DELETE FROM unknown_parent_pools" && ! as_user t_web "SELECT unknown_parent_pools_refresh('"'"'\\x00'"'"', ARRAY[1], now(), now())"'
check "collector: no unknown_parent_pools access" '! as_user t_collector "SELECT 1 FROM unknown_parent_pools" && ! as_user t_collector "SELECT unknown_parent_pools_refresh('"'"'\\x00'"'"', ARRAY[1], now(), now())"'
psql_ "DROP OWNED BY t_collector, t_backend, t_web, t_mempool, t_clock; DROP USER t_collector, t_backend, t_web, t_mempool, t_clock;" >/dev/null

check "compress a chunk"                 '[ "$(psql_ "SELECT count(compress_chunk(c)) FROM show_chunks('"'"'templates'"'"') c")" -ge 1 ]'
check "one stream per pool: window constants" '[ "$(psql_ "SELECT template_stream_silence() || '"'"' '"'"' || template_stream_lead()")" = "00:01:30 00:00:10" ]'
check "stale-tip read: every connection, grants kept" '[ "$(psql_ "SELECT prosrc LIKE '"'"'%FROM templates t%'"'"' AND prosrc NOT LIKE '"'"'%templates_dedup%'"'"' AND has_function_privilege('"'"'stratum_web'"'"', oid, '"'"'EXECUTE'"'"') AND has_function_privilege('"'"'stratum_backend'"'"', oid, '"'"'EXECUTE'"'"') AND NOT has_function_privilege('"'"'stratum_collector'"'"', oid, '"'"'EXECUTE'"'"') FROM pg_proc WHERE proname = '"'"'stale_tip_templates'"'"'")" = t ]'
check "old views, the dedup report and the backfill tool's schema are gone" '[ "$(psql_ "SELECT count(*) FROM pg_views WHERE viewname IN ('"'"'templates_copies'"'"', '"'"'templates_dedup'"'"')")" = 0 ] && [ "$(psql_ "SELECT count(*) FROM pg_proc WHERE proname = '"'"'template_dedup_report'"'"'")" = 0 ] && [ "$(psql_ "SELECT count(*) FROM pg_namespace WHERE nspname = '"'"'mongo_to_postgres'"'"'")" = 0 ]'
check "templates_other, its views and the chain type are gone" '[ "$(psql_ "SELECT count(*) FROM pg_class WHERE relname LIKE '"'"'templates_other%'"'"'")" = 0 ] && [ "$(psql_ "SELECT count(*) FROM pg_type WHERE typname = '"'"'chain'"'"'")" = 0 ]'
check "down drops unknown_parent_pools + its function" 'dbmate down && [ "$(psql_ "SELECT count(*) FROM pg_tables WHERE tablename = '"'"'unknown_parent_pools'"'"'")" = 0 ] && [ "$(psql_ "SELECT count(*) FROM pg_proc WHERE proname = '"'"'unknown_parent_pools_refresh'"'"'")" = 0 ]'
check "down drops header_source and the imported rows, restores the status checks" 'psql_ "INSERT INTO stale_blocks (block_hash, height, prev_hash, version, block_time, bits, nonce, merkle_root, chaintip_status, last_status, tip_hash, fork_height) VALUES ('"'"'\\x0a'"'"', 2, '"'"'\\x01'"'"', 1, now(), 1, 1, '"'"'\\x00'"'"', '"'"'valid-fork'"'"', '"'"'valid-fork'"'"', '"'"'\\x0a'"'"', 1), ('"'"'\\x0b'"'"', 2, '"'"'\\x01'"'"', 1, now(), 1, 1, '"'"'\\x00'"'"', '"'"'not-in-node'"'"', '"'"'not-in-node'"'"', '"'"'\\x0b'"'"', 1)" && psql_ "UPDATE stale_blocks SET header_source = '"'"'bitcoin-data/stale-blocks'"'"' WHERE block_hash = '"'"'\\x0b'"'"'" && dbmate down && [ "$(psql_ "SELECT count(*) FROM information_schema.columns WHERE table_name = '"'"'stale_blocks'"'"' AND column_name = '"'"'header_source'"'"'")" = 0 ] && [ "$(psql_ "SELECT string_agg(encode(block_hash, '"'"'hex'"'"'), '"'"','"'"') FROM stale_blocks")" = 0a ] && ! psql_ "UPDATE stale_blocks SET last_status = '"'"'not-in-node'"'"'" && psql_ "DELETE FROM stale_blocks"'
check "down restores the old views and the dedup report (grants kept)" 'dbmate down && [ "$(psql_ "SELECT count(*) FROM pg_views WHERE viewname IN ('"'"'templates_copies'"'"', '"'"'templates_dedup'"'"')")" = 2 ] && [ "$(psql_ "SELECT has_function_privilege('"'"'stratum_web'"'"', '"'"'template_dedup_report(timestamptz, timestamptz)'"'"', '"'"'EXECUTE'"'"') AND has_table_privilege('"'"'stratum_web'"'"', '"'"'templates_dedup'"'"', '"'"'SELECT'"'"')")" = t ]'
check "down restores an empty templates_other: hypertable, policy, views, grants" 'dbmate down && [ "$(psql_ "SELECT count(*) FROM timescaledb_information.jobs WHERE hypertable_name = '"'"'templates_other'"'"' AND proc_name = '"'"'policy_compression'"'"'")" = 1 ] && [ "$(psql_ "SELECT count(*) FROM pg_views WHERE viewname IN ('"'"'templates_other_copies'"'"', '"'"'templates_other_dedup'"'"')")" = 2 ] && [ "$(psql_ "SELECT has_table_privilege('"'"'stratum_collector'"'"', '"'"'templates_other'"'"', '"'"'INSERT'"'"') AND has_table_privilege('"'"'stratum_web'"'"', '"'"'templates_other_dedup'"'"', '"'"'SELECT'"'"')")" = t ]'
check "drop keeps another schema's chain column as text (values intact)" 'psql_ "CREATE SCHEMA tool_x; CREATE TABLE tool_x.moved (n int, from_chain chain); INSERT INTO tool_x.moved VALUES (1, '"'"'bch'"'"'), (2, '"'"'unknown'"'"')" && dbmate up && [ "$(psql_ "SELECT data_type || '"'"':'"'"' || string_agg(from_chain, '"'"','"'"' ORDER BY n) FROM tool_x.moved, information_schema.columns WHERE table_schema = '"'"'tool_x'"'"' AND column_name = '"'"'from_chain'"'"' GROUP BY data_type")" = "text:bch,unknown" ] && psql_ "DROP SCHEMA tool_x CASCADE" && dbmate down && dbmate down && dbmate down && dbmate down'   # up applied 8, 9, header_source and unknown_parent_pools: back to 7
check "down drops template_routing_labels" 'dbmate down && [ "$(psql_ "SELECT count(*) FROM pg_tables WHERE tablename = '"'"'template_routing_labels'"'"'")" = 0 ]'
check "down drops the one-table read functions, restores stale_tip_templates" 'dbmate down && [ "$(psql_ "SELECT count(*) FROM pg_proc WHERE proname IN ('"'"'height_window'"'"', '"'"'template_height_windows'"'"') OR (proname IN ('"'"'templates_dedup'"'"', '"'"'templates_copies'"'"'))")" = 0 ] && [ "$(psql_ "SELECT l.lanname FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.proname = '"'"'stale_tip_templates'"'"'")" = sql ] && [ "$(psql_ "SELECT count(*) FROM pg_views WHERE viewname = '"'"'bitcoin_parents'"'"'")" = 0 ]'
check "down drops the block coinbase columns + match function" 'dbmate down && [ "$(psql_ "SELECT count(*) FROM information_schema.columns WHERE table_name = '"'"'blocks'"'"' AND column_name IN ('"'"'merkle_branches'"'"', '"'"'coinbase_txid'"'"', '"'"'coinbase_tx'"'"')")" = 0 ] && [ "$(psql_ "SELECT count(*) FROM pg_proc WHERE proname = '"'"'block_template_matches'"'"'")" = 0 ]'
check "down drops the clock_samples policy" 'dbmate down && [ "$(psql_ "SELECT count(*) FROM timescaledb_information.jobs WHERE hypertable_name = '"'"'clock_samples'"'"'")" = 0 ]'
check "down drops clock_samples + role"   'dbmate down && [ "$(psql_ "SELECT count(*) FROM pg_tables WHERE tablename = '"'"'clock_samples'"'"'")" = 0 ] && [ "$(psql_ "SELECT count(*) FROM pg_roles WHERE rolname = '"'"'stratum_clock'"'"'")" = 0 ]'
check "down restores the two ingest_events kinds" 'dbmate down && ! psql_ "INSERT INTO ingest_events (source_id, kind, started_at, ended_at, templates) SELECT id, '"'"'start'"'"', now(), now(), 0 FROM sources LIMIT 1"'
check "down drops blocks.seen_via"        'dbmate down && [ "$(psql_ "SELECT count(*) FROM information_schema.columns WHERE table_name = '"'"'blocks'"'"' AND column_name = '"'"'seen_via'"'"'")" = 0 ]'
check "down drops the prevout index"      'dbmate down && [ "$(psql_ "SELECT count(*) FROM pg_indexes WHERE indexname = '"'"'mempool_tx_inputs_prevout'"'"'")" = 0 ] && [ "$(psql_ "SELECT count(*) FROM pg_indexes WHERE indexname = '"'"'mempool_tx_inputs_tx'"'"'")" = 1 ]'
check "down restores the templates_dedup stale-tip read" 'dbmate down && [ "$(psql_ "SELECT prosrc LIKE '"'"'%FROM templates_dedup d%'"'"' AND has_function_privilege('"'"'stratum_web'"'"', oid, '"'"'EXECUTE'"'"') AND has_function_privilege('"'"'stratum_backend'"'"', oid, '"'"'EXECUTE'"'"') AND NOT has_function_privilege('"'"'stratum_collector'"'"', oid, '"'"'EXECUTE'"'"') FROM pg_proc WHERE proname = '"'"'stale_tip_templates'"'"'")" = t ] && [ "$(psql_ "SELECT count(*) FROM pg_views WHERE viewname = '"'"'blocks_best'"'"'")" = 1 ]'
check "down drops blocks_best"           'dbmate down && [ "$(psql_ "SELECT count(*) FROM pg_views WHERE viewname = '"'"'blocks_best'"'"'")" = 0 ] && [ "$(psql_ "SELECT count(*) FROM pg_tables WHERE tablename = '"'"'stale_blocks'"'"'")" = 1 ]'
check "down restores the exact-copies-only views" 'dbmate down && [ "$(psql_ "SELECT count(*) FROM pg_views WHERE viewname LIKE '"'"'templates%'"'"'")" = 4 ] && [ "$(psql_ "SELECT count(*) FROM pg_proc WHERE proname LIKE '"'"'template_stream_%'"'"'")" = 0 ] && [ "$(psql_ "SELECT count(*) FROM information_schema.columns WHERE table_name = '"'"'templates_copies'"'"' AND column_name = '"'"'primary_match'"'"'")" = 0 ] && psql_ "SELECT gap_fills FROM template_dedup_report(now() - interval '"'"'1 day'"'"', now())" && ! psql_ "SELECT secondary_stream FROM template_dedup_report(now() - interval '"'"'1 day'"'"', now())"'
check "down drops the stale-block tables + functions" 'dbmate down && [ "$(psql_ "SELECT count(*) FROM pg_tables WHERE tablename IN ('"'"'stale_blocks'"'"', '"'"'chain_reorgs'"'"')")" = 0 ] && [ "$(psql_ "SELECT count(*) FROM pg_proc WHERE proname IN ('"'"'stale_tip_templates'"'"', '"'"'stratum_prev_hash_to_block_hash'"'"')")" = 0 ]'
check "down drops the mempool policies"   'dbmate down && [ "$(psql_ "SELECT count(*) FROM timescaledb_information.jobs WHERE hypertable_name LIKE '"'"'mempool%'"'"'")" = 0 ]'
check "down drops the mempool tables + role" 'dbmate down && [ "$(psql_ "SELECT count(*) FROM pg_tables WHERE tablename LIKE '"'"'mempool%'"'"'")" = 0 ] && [ "$(psql_ "SELECT count(*) FROM pg_roles WHERE rolname = '"'"'stratum_mempool'"'"'")" = 0 ] && [ "$(psql_ "SELECT count(*) FROM pg_proc WHERE proname LIKE '"'"'hash_%display'"'"'")" = 0 ]'
check "down drops the dedup views + report" 'dbmate down && [ "$(psql_ "SELECT count(*) FROM pg_views WHERE viewname LIKE '"'"'templates%'"'"'")" = 0 ] && [ "$(psql_ "SELECT count(*) FROM pg_proc WHERE proname = '"'"'template_dedup_report'"'"'")" = 0 ]'
check "down drops ingest_events"        'dbmate down && [ "$(psql_ "SELECT count(*) FROM pg_tables WHERE tablename = '"'"'ingest_events'"'"'")" = 0 ]'
check "down drops the quarantine table"  'dbmate down && [ "$(psql_ "SELECT count(*) FROM pg_tables WHERE tablename = '"'"'templates_rejected'"'"'")" = 0 ]'
check "down refuses to merge two replicas" '! dbmate down && [ "$(psql_ "SELECT count(*) FROM schema_migrations")" = 6 ]'
psql_ "DELETE FROM sources WHERE replica <> 'a'" >/dev/null
check "migrate down to zero"             'for _ in 1 2 3 4 5 6; do dbmate down || exit 1; done'
check "down left nothing behind"         '[ "$(psql_ "SELECT count(*) FROM pg_tables WHERE schemaname = '"'"'public'"'"' AND tablename <> '"'"'schema_migrations'"'"'")" = 0 ] && [ "$(psql_ "SELECT count(*) FROM pg_roles WHERE rolname LIKE '"'"'stratum_%'"'"'")" = 0 ]'
check "migrate up again"                 'dbmate up'
check "all migrations recorded again"  '[ "$(psql_ "SELECT count(*) FROM schema_migrations")" = 27 ]'

echo "RESULT: $ok passed, $bad failed"
[ "$bad" = 0 ]
