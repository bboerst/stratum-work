#!/usr/bin/env bash
# End-to-end test of the backfill tool on the synthetic fixture (tests/fixture.py), against throwaway MongoDB and
# TimescaleDB containers (the repo's dbmate migrations applied). Needs Docker; touches nothing else.
#
#   tools/mongo-to-postgres/test-e2e.sh
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
cleanup() { docker rm -f "$PG" "$MONGO" "$PY" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT

docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD=test "$PG_IMAGE" -c timescaledb.enable_chunk_skipping=on >/dev/null
docker run -d --name "$MONGO" --network "$NET" "$MONGO_IMAGE" >/dev/null
docker run -d --name "$PY" --network "$NET" -v "$REPO:/repo:ro" -w /repo/tools/mongo-to-postgres \
  -e MONGO_URI="mongodb://$MONGO:27017" -e PGHOST="$PG" -e PGUSER=postgres -e PGDATABASE=postgres -e PGPASSWORD=test \
  -e PYTHONDONTWRITEBYTECODE=1 "$PY_IMAGE" sleep infinity >/dev/null
docker exec "$PY" pip install -q --root-user-action=ignore --disable-pip-version-check -r requirements-dev.txt
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
echo "== verify catches problems"
# By key, not ctid: the compression policy may already have compressed the chunk, and ctid doesn't work there.
psql_ "DELETE FROM templates WHERE (source_id, received_at, job_id) IN (SELECT source_id, received_at, job_id FROM templates WHERE height = 870033 LIMIT 1)" >/dev/null
check "a missing row fails counts"               '! m2p verify --known-gap 870040-870042 --sample 50 > $TMP/v2.txt; grep -q "^FAIL  counts" $TMP/v2.txt'
docker exec "$MONGO" mongosh --quiet stratum-logger --eval 'db.mining_notify.insertOne({_id: "odd", timestamp: 12345})' >/dev/null
check "an unrecognized timestamp fails coverage" '! m2p verify --known-gap 870040-870042 --sample 50 > $TMP/v3.txt; grep -q "^FAIL  coverage" $TMP/v3.txt'

echo "== $ok passed, $bad failed"
[ "$bad" = 0 ]
