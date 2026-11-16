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
check "templates, templates_other, mempool_txs, mempool_tx_raw: hypertables with columnstore" '[ "$(psql_ "SELECT count(*) FROM timescaledb_information.hypertables WHERE compression_enabled")" = 4 ]'
check "chunk skipping on templates.height" '[ "$(psql_ "SELECT count(*) FROM _timescaledb_catalog.chunk_column_stats WHERE column_name = '"'"'height'"'"'")" -ge 1 ]'
check "4 columnstore policy jobs"        '[ "$(psql_ "SELECT count(*) FROM timescaledb_information.jobs WHERE proc_name = '"'"'policy_compression'"'"'")" = 4 ]'
check "retention job on mempool_tx_raw"  '[ "$(psql_ "SELECT hypertable_name FROM timescaledb_information.jobs WHERE proc_name = '"'"'policy_retention'"'"'")" = mempool_tx_raw ]'
check "all migrations recorded"        '[ "$(psql_ "SELECT count(*) FROM schema_migrations")" = 11 ]'

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
check "web: read the de-duplicated views" 'as_user t_web "SELECT count(*) FROM templates_dedup WHERE height = 975500; SELECT count(*) FROM templates_other_dedup WHERE height = 975500; SELECT count(*) FROM templates_copies WHERE height = 975500; SELECT count(*) FROM templates_other_copies WHERE height = 975500"'
check "backend: read the de-duplicated view" '[ "$(as_user t_backend "SELECT copies FROM templates_dedup WHERE height = 975500")" = 1 ]'
check "web + backend: run the dedup report" 'as_user t_web "SELECT * FROM template_dedup_report(now() - interval '"'"'1 day'"'"', now() + interval '"'"'1 day'"'"')" && as_user t_backend "SELECT * FROM template_dedup_report(now() - interval '"'"'1 day'"'"', now() + interval '"'"'1 day'"'"')"'
check "collector: cannot read the views"  '! as_user t_collector "SELECT 1 FROM templates_dedup WHERE height = 975500"'
check "collector: cannot run the report"  '! as_user t_collector "SELECT * FROM template_dedup_report(now() - interval '"'"'1 day'"'"', now())"'
check "dedup: synthetic replicas, sites and report" 'docker exec -i "$PG" psql -h localhost -U postgres -v ON_ERROR_STOP=1 -q < db/test-templates-dedup.sql'
# mempool recorder (mempool-recorder/): its own tables only; backend and web read them
psql_ "CREATE USER t_mempool LOGIN PASSWORD 'x' IN ROLE stratum_mempool" >/dev/null
G=4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b  # genesis coinbase txid, display order
check "txid byte order: internal bytes are the reversed display hex" '[ "$(psql_ "SELECT encode(hash_from_display('"'"'$G'"'"'), '"'"'hex'"'"')")" = 3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a ] && [ "$(psql_ "SELECT hash_display(hash_from_display('"'"'$G'"'"'))")" = $G ]'
MTX="INSERT INTO mempool_txs (first_seen, first_seen_src, txid, inputs) VALUES (now() - interval '1 minute', 'zmq', hash_from_display('$G'), '\\x')"
check "mempool: insert a tx"             'as_user t_mempool "$MTX"'
check "mempool: same txid + first_seen is unique" '! as_user t_mempool "INSERT INTO mempool_txs (first_seen, first_seen_src, txid, inputs) SELECT first_seen, '"'"'zmq'"'"', txid, inputs FROM mempool_txs"'
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
check "web + backend: read the mempool tables" 'as_user t_web "SELECT count(*) FROM mempool_txs, mempool_blocks, mempool_offmempool, mempool_tx_raw" && as_user t_backend "SELECT count(*) FROM mempool_txs, mempool_blocks, mempool_offmempool, mempool_tx_raw"'
check "web: cannot write the mempool tables" '! as_user t_web "$MTX"'
check "collector: no mempool access"     '! as_user t_collector "SELECT 1 FROM mempool_txs" && ! as_user t_collector "$MTX"'
check "mempool: bloom sparse index after compression" '[ "$(psql_ "SELECT count(compress_chunk(c)) FROM show_chunks('"'"'mempool_txs'"'"') c")" -ge 1 ] && [ "$(as_user t_backend "SELECT removal FROM mempool_txs WHERE txid = hash_from_display('"'"'$G'"'"')")" = mined ] && psql_ "EXPLAIN SELECT 1 FROM mempool_txs WHERE txid = hash_from_display('"'"'$G'"'"')" | grep -q bloom'
psql_ "DROP OWNED BY t_collector, t_backend, t_web, t_mempool; DROP USER t_collector, t_backend, t_web, t_mempool;" >/dev/null

check "compress a chunk"                 '[ "$(psql_ "SELECT count(compress_chunk(c)) FROM show_chunks('"'"'templates'"'"') c")" -ge 1 ]'
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
check "all migrations recorded again"  '[ "$(psql_ "SELECT count(*) FROM schema_migrations")" = 11 ]'

echo "RESULT: $ok passed, $bad failed"
[ "$bad" = 0 ]
