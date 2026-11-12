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
cleanup() { docker rm -f "$PG" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
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
check "templates + templates_other are hypertables with columnstore" '[ "$(psql_ "SELECT count(*) FROM timescaledb_information.hypertables WHERE compression_enabled")" = 2 ]'
check "chunk skipping on templates.height" '[ "$(psql_ "SELECT count(*) FROM _timescaledb_catalog.chunk_column_stats WHERE column_name = '"'"'height'"'"'")" -ge 1 ]'
check "2 columnstore policy jobs"        '[ "$(psql_ "SELECT count(*) FROM timescaledb_information.jobs WHERE proc_name = '"'"'policy_compression'"'"'")" = 2 ]'
check "all 4 migrations recorded"        '[ "$(psql_ "SELECT count(*) FROM schema_migrations")" = 4 ]'

# role privileges: create login users the way an environment would
psql_ "CREATE USER t_collector LOGIN PASSWORD 'x' IN ROLE stratum_collector; CREATE USER t_backend LOGIN PASSWORD 'x' IN ROLE stratum_backend; CREATE USER t_web LOGIN PASSWORD 'x' IN ROLE stratum_web;" >/dev/null
INS="INSERT INTO templates (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2, merkle_branches, version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length) SELECT now(), id, 975500, 'j', '\\x00', '\\x01', '\\x02', '', 1, 2, 3, true, '\\x03', 8 FROM sources LIMIT 1"
check "collector: register a source"     'as_user t_collector "INSERT INTO sources (name, site) VALUES ('"'"'p1'"'"', '"'"'local'"'"')"'
check "collector: insert a template"     'as_user t_collector "$INS"'
check "collector: cannot read blocks"    '! as_user t_collector "SELECT 1 FROM blocks"'
check "collector: cannot delete templates" '! as_user t_collector "DELETE FROM templates"'
check "backend: read templates"          '[ "$(as_user t_backend "SELECT count(*) FROM templates")" = 1 ]'
check "backend: write blocks"            'as_user t_backend "INSERT INTO blocks (block_hash, height, block_time, coinbase_script_sig) VALUES ('"'"'\\x01'"'"', 975499, now(), '"'"'\\x00'"'"')"'
check "backend: cannot write templates"  '! as_user t_backend "$INS"'
check "web: read blocks"                 '[ "$(as_user t_web "SELECT count(*) FROM blocks")" = 1 ]'
check "web: cannot write anything"       '! as_user t_web "INSERT INTO pools (id, name) VALUES (1, '"'"'x'"'"')"'
check "web: no DDL"                      '! as_user t_web "CREATE TABLE x (i int)"'
psql_ "DROP OWNED BY t_collector, t_backend, t_web; DROP USER t_collector, t_backend, t_web;" >/dev/null

check "compress a chunk"                 '[ "$(psql_ "SELECT count(compress_chunk(c)) FROM show_chunks('"'"'templates'"'"') c")" -ge 1 ]'
check "migrate down to zero"             'dbmate down && dbmate down && dbmate down && dbmate down'
check "down left nothing behind"         '[ "$(psql_ "SELECT count(*) FROM pg_tables WHERE schemaname = '"'"'public'"'"' AND tablename <> '"'"'schema_migrations'"'"'")" = 0 ] && [ "$(psql_ "SELECT count(*) FROM pg_roles WHERE rolname LIKE '"'"'stratum_%'"'"'")" = 0 ]'
check "migrate up again"                 'dbmate up'
check "all 4 migrations recorded again"  '[ "$(psql_ "SELECT count(*) FROM schema_migrations")" = 4 ]'

echo "RESULT: $ok passed, $bad failed"
[ "$bad" = 0 ]
