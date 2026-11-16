#!/usr/bin/env bash
# End-to-end test of the backfill tool on the synthetic fixture (tests/fixture.py), against throwaway MongoDB and
# TimescaleDB containers (the repo's dbmate migrations applied). Needs Docker; touches nothing else.
#
#   tools/mongo-to-postgres/test-e2e.sh
#   M2P_IMAGE=<image> tools/mongo-to-postgres/test-e2e.sh   # the same checks against the tool's image (Dockerfile)
set -uo pipefail
cd "$(dirname "$0")/../.."
REPO=$PWD
DBMATE=ghcr.io/amacneil/dbmate:2.37.0
PG_IMAGE=timescale/timescaledb:2.30.2-pg18
MONGO_IMAGE=mongo:7.0.24
PY_IMAGE=python:3.13-slim
NET=m2p-e2e-$$; PG=m2p-e2e-pg-$$; MONGO=m2p-e2e-mongo-$$; PY=m2p-e2e-py-$$
TMP=$(mktemp -d); ok=0; bad=0
check() { if eval "$2" >/dev/null 2>&1; then echo "  PASS  $1"; ok=$((ok+1)); else echo "  FAIL  $1"; bad=$((bad+1)); fi; }
cleanup() { docker rm -fv "$PG" "$MONGO" "$PY" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT

docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD=test "$PG_IMAGE" -c timescaledb.enable_chunk_skipping=on >/dev/null
docker run -d --name "$MONGO" --network "$NET" "$MONGO_IMAGE" >/dev/null
PY_ENV=(-e MONGO_URI="mongodb://$MONGO:27017" -e PGHOST="$PG" -e PGUSER=postgres -e PGDATABASE=postgres -e PGPASSWORD=test
        -e PYTHONDONTWRITEBYTECODE=1)
if [ -n "${M2P_IMAGE:-}" ]; then
  # The image holds the tool and the modules it loads; only the tests and their dependencies are added.
  docker run -d --name "$PY" --network "$NET" --entrypoint sleep "${PY_ENV[@]}" \
    -v "$REPO/tools/mongo-to-postgres/tests:/app/tools/mongo-to-postgres/tests:ro" \
    -v "$REPO/tools/mongo-to-postgres/requirements-dev.txt:/app/tools/mongo-to-postgres/requirements-dev.txt:ro" \
    "$M2P_IMAGE" infinity >/dev/null
  docker exec -u 0 "$PY" pip install -q --root-user-action=ignore --disable-pip-version-check -r requirements-dev.txt
else
  docker run -d --name "$PY" --network "$NET" -v "$REPO:/repo:ro" -w /repo/tools/mongo-to-postgres "${PY_ENV[@]}" \
    "$PY_IMAGE" sleep infinity >/dev/null
  docker exec "$PY" pip install -q --root-user-action=ignore --disable-pip-version-check -r requirements-dev.txt
fi
for i in $(seq 60); do docker exec "$PG" pg_isready -h localhost -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
docker run --rm --network "$NET" -v "$REPO/db:/db" -e DATABASE_URL="postgres://postgres:test@$PG:5432/postgres?sslmode=disable" \
  -e DBMATE_NO_DUMP_SCHEMA=true "$DBMATE" --wait up >/dev/null
py() { docker exec "$PY" "$@"; }
m2p() { docker exec "$PY" python -m m2p "$@"; }
psql_() { docker exec "$PG" psql -h localhost -U postgres -v ON_ERROR_STOP=1 -At -c "$1"; }

echo "== unit tests"
check "pytest"                                    'py python -m pytest -q -p no:cacheprovider tests'
echo "== fixture"
py python tests/fixture.py load
echo "== migrate (2 workers)"
m2p migrate --workers 2 --create-index 2>&1 | tee $TMP/migrate.log | grep -E "INFO (2024|done|days|blocks|pools)" | cut -c25-
check "migrate: all days done"                    'grep -q "done: 4 days" $TMP/migrate.log'
echo "== verify"
m2p verify --known-gap 870040-870042 --out /tmp/verify.json | grep -E "^(PASS|WARN|FAIL|OVERALL)"
check "verify exits 0 (no FAIL)"                  'm2p verify --known-gap 870040-870042 --out /tmp/verify.json'
echo "== fixture expectations"
py python tests/fixture.py check /tmp/verify.json; [ $? = 0 ] && ok=$((ok+1)) || bad=$((bad+1))
echo "== resumability"
check "re-run skips every day"                    '[ "$(m2p migrate 2>&1 | grep -c "0 to do")" = 1 ]'
check "re-run loads nothing twice"               '[ "$(psql_ "SELECT count(*) FROM templates")" = 540 ]'
echo "== report"
m2p report --verify-json /tmp/verify.json | sed -n '1,12p'
echo "== per-pool cut-off (--pool-until): global cut T0, PoolB until T_L; its own MongoDB and Postgres databases"
T0=2024-11-11T22:00:00Z; TL=2024-11-12T02:00:00Z   # = tests/fixture.py POOL_T0 / POOL_TL
psqldb() { docker exec "$PG" psql -h localhost -U postgres -d "$1" -v ON_ERROR_STOP=1 -At -c "$2"; }
m2pdb() { local db=$1; shift; docker exec -e MONGO_DB=m2p-pool -e PGDATABASE="$db" "$PY" python -m m2p "$@"; }
for db in pool_once pool_twice; do
  psql_ "CREATE DATABASE $db" >/dev/null
  docker run --rm --network "$NET" -v "$REPO/db:/db" -e DATABASE_URL="postgres://postgres:test@$PG:5432/$db?sslmode=disable" \
    -e DBMATE_NO_DUMP_SCHEMA=true "$DBMATE" --wait up >/dev/null
done
docker exec -e MONGO_DB=m2p-pool "$PY" python tests/fixture.py load
# Everything a run produced, independent of source ids and timings: rows and bookkeeping.
FP="SELECT md5(string_agg(x, E'\\n' ORDER BY x)) FROM (
  SELECT 't' || s.name || (to_jsonb(t) - 'source_id')::text x FROM templates t JOIN sources s ON s.id = t.source_id UNION ALL
  SELECT 'o' || s.name || (to_jsonb(t) - 'source_id')::text FROM templates_other t JOIN sources s ON s.id = t.source_id UNION ALL
  SELECT 'd' || (to_jsonb(d) - 'seconds' - 'finished_at' - 'stats')::text FROM mongo_to_postgres.days d UNION ALL
  SELECT 's' || to_jsonb(x)::text FROM mongo_to_postgres.day_sources x UNION ALL
  SELECT 'z' || (to_jsonb(x) - 'evidence')::text FROM mongo_to_postgres.tz_findings x UNION ALL
  SELECT 'r' || to_jsonb(x)::text FROM mongo_to_postgres.rejected x UNION ALL
  SELECT 'u' || to_jsonb(x)::text FROM mongo_to_postgres.duplicates x UNION ALL
  SELECT 'n' || name || site || first_seen_at::text FROM sources) q"
# one pass with the option
m2pdb pool_once migrate --workers 2 --until $T0 --pool-until PoolB=$TL > $TMP/once.log 2>&1
check "one pass: 3 days loaded (one empty)"       'grep -q "done: 3 days" $TMP/once.log'
m2pdb pool_once verify --known-gap 870040-870042 --sample 200 --out /tmp/pool-once.json > $TMP/pool-once.txt; rc=$?
check "one pass: verify exits 0"                  '[ $rc = 0 ]'
grep -E "^(FAIL|OVERALL)|pool window" $TMP/pool-once.txt
docker exec -e PGDATABASE=pool_once "$PY" python tests/fixture.py check-pool-until /tmp/pool-once.json; [ $? = 0 ] && ok=$((ok+1)) || bad=$((bad+1))
# first pass without it, then a second pass adding it (and --only-pools PoolB, which keeps the others as they are)
m2pdb pool_twice migrate --workers 2 --until $T0 > $TMP/twice1.log 2>&1
check "first pass (no option): 2 days"           'grep -q "done: 2 days" $TMP/twice1.log'
# A PoolA row of the T0 day, marked: a second pass must neither delete nor reload it.
SENT="(SELECT s.id FROM sources s WHERE s.name = 'PoolA') = source_id AND job_id = '870005-PoolA-0'"
LAT=$(psqldb pool_twice "SELECT latency_ms FROM templates WHERE $SENT")
psqldb pool_twice "UPDATE templates SET latency_ms = 777 WHERE $SENT" >/dev/null
m2pdb pool_twice migrate --workers 2 --until $T0 --pool-until PoolB=$TL --only-pools PoolB > $TMP/twice2.log 2>&1
check "second pass: T0 day reloads PoolB only, next day new" \
  'grep -q "2 to do (new 1, sources 1)" $TMP/twice2.log && grep -q "2024-11-11 (until 2024-11-11T22:00:00+00:00, PoolB whole day) (reloaded PoolB only)" $TMP/twice2.log'
check "second pass: other pools' rows untouched"  '[ "$(psqldb pool_twice "SELECT latency_ms FROM templates WHERE $SENT")" = 777 ]'
psqldb pool_twice "UPDATE templates SET latency_ms = $LAT WHERE $SENT" >/dev/null
FP1=$(psqldb pool_once "$FP"); FP2=$(psqldb pool_twice "$FP")
check "second pass gives the same result as one pass" '[ ${#FP1} = 32 ] && [ "$FP1" = "$FP2" ] && [ -n "$LAT" ]'
m2pdb pool_twice verify --known-gap 870040-870042 --sample 200 --out /tmp/pool-twice.json > $TMP/pool-twice.txt; rc=$?
check "two passes: verify exits 0"                '[ $rc = 0 ]'
docker exec -e PGDATABASE=pool_twice "$PY" python tests/fixture.py check-pool-until /tmp/pool-twice.json; [ $? = 0 ] && ok=$((ok+1)) || bad=$((bad+1))
for db in pool_once pool_twice; do
  check "$db: rerun is a no-op"                   '[ "$(m2pdb '$db' migrate --until $T0 --pool-until PoolB=$TL 2>&1 | grep -c "0 to do")" = 1 ]'
  check "$db: rerun without the option keeps PoolB" '[ "$(m2pdb '$db' migrate --until $T0 2>&1 | grep -c "0 to do")" = 1 ]'
done
check "reruns changed nothing"                    '[ "$(psqldb pool_once "$FP")" = "$FP1" ] && [ "$(psqldb pool_twice "$FP")" = "$FP1" ]'
m2pdb pool_once report --verify-json /tmp/pool-once.json > $TMP/pool-report.md 2>/dev/null
grep -A3 "^### Per-pool" $TMP/pool-report.md
check "report lists the per-pool cut and window"  'grep -q "^| .PoolB. | 2024-11-11 … 2024-11-12 (2) | 2024-11-12T02:00:00+00:00 | 148 | 100 | exact |" $TMP/pool-report.md'
# If another source's rows would come out differently, a per-source reload falls back to the whole day.
psqldb pool_twice "DELETE FROM templates WHERE $SENT" >/dev/null
m2pdb pool_twice migrate --until $T0 --pool-until PoolB=$TL --pool-until PoolC=2024-11-11T23:00:00Z > $TMP/twice3.log 2>&1
check "changed other rows: falls back to the whole day" \
  'grep -q "rows of sources other than \\[.PoolC.\\] would change" $TMP/twice3.log && grep -q "2024-11-11 .* (reloaded):" $TMP/twice3.log'
check "fallback restored the deleted row"         '[ "$(psqldb pool_twice "SELECT count(*) FROM templates WHERE $SENT")" = 1 ]'
MODE=$(psqldb pool_twice "SELECT stats->'redo'->>'mode' FROM mongo_to_postgres.days WHERE day = '2024-11-11'")
check "fallback recorded in the day's stats"      '[ "$MODE" = day ]'

echo "== verify catches problems"
# By key, not ctid: the compression policy may already have compressed the chunk, and ctid doesn't work there.
psql_ "DELETE FROM templates WHERE (source_id, received_at, job_id) IN (SELECT source_id, received_at, job_id FROM templates WHERE height = 870033 LIMIT 1)" >/dev/null
check "a missing row fails counts"               '! m2p verify --known-gap 870040-870042 --sample 50 > $TMP/v2.txt; grep -q "^FAIL  counts" $TMP/v2.txt'
docker exec "$MONGO" mongosh --quiet stratum-logger --eval 'db.mining_notify.insertOne({_id: "odd", timestamp: 12345})' >/dev/null
check "an unrecognized timestamp fails coverage" '! m2p verify --known-gap 870040-870042 --sample 50 > $TMP/v3.txt; grep -q "^FAIL  coverage" $TMP/v3.txt'

echo "== $ok passed, $bad failed"
[ "$bad" = 0 ]
