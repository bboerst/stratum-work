#!/usr/bin/env bash
# End-to-end test of replica-compare: unit tests, then the synthetic fixture (tests/fixture.py) loaded into a
# throwaway TimescaleDB with the repo's dbmate migrations, analysed through a read-only stratum_web login. Needs
# Docker; touches nothing else.
#
#   tools/replica-compare/test-e2e.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
REPO=$PWD
DBMATE=ghcr.io/amacneil/dbmate:2.37.0
PG_IMAGE=timescale/timescaledb:2.30.2-pg18
PY_IMAGE=python:3.13-slim
NET=rc-e2e-$$; PG=rc-e2e-pg-$$; PY=rc-e2e-py-$$
ok=0; bad=0
check() { if eval "$2" >/dev/null 2>&1; then echo "  PASS  $1"; ok=$((ok+1)); else echo "  FAIL  $1"; bad=$((bad+1)); fi; }
cleanup() { docker rm -fv "$PG" "$PY" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
trap cleanup EXIT

docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD=test "$PG_IMAGE" -c timescaledb.enable_chunk_skipping=on >/dev/null
docker run -d --name "$PY" --network "$NET" -v "$REPO:/repo:ro" -w /repo/tools/replica-compare \
  -e PGHOST="$PG" -e PGUSER=postgres -e PGDATABASE=postgres -e PGPASSWORD=test -e PYTHONDONTWRITEBYTECODE=1 \
  "$PY_IMAGE" sleep infinity >/dev/null
docker exec "$PY" pip install -q --root-user-action=ignore --disable-pip-version-check -r requirements-dev.txt
for i in $(seq 60); do docker exec "$PG" pg_isready -h localhost -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
docker run --rm --network "$NET" -v "$REPO/db:/db:ro" -e DATABASE_URL="postgres://postgres:test@$PG:5432/postgres?sslmode=disable" \
  -e DBMATE_NO_DUMP_SCHEMA=true "$DBMATE" --wait up >/dev/null
docker exec "$PG" psql -h localhost -U postgres -q -c "CREATE USER t_web LOGIN PASSWORD 'x' IN ROLE stratum_web" >/dev/null
py() { docker exec "$PY" "$@"; }
rc() { docker exec -e PGUSER=t_web -e PGPASSWORD=x "$PY" python -m replica_compare "$@"; }

echo "== unit tests"
check "pytest"                               'py python -m pytest -q -p no:cacheprovider tests'
echo "== fixture"
py python tests/fixture.py load
echo "== analyse (read-only role)"
check "runs as stratum_web"                  'rc --since 2030-01-01T00:00:00Z --until 2030-01-01T01:00:00Z --site test --out /tmp/r.md --json /tmp/r.json'
py python tests/fixture.py check /tmp/r.json; [ $? = 0 ] && ok=$((ok+1)) || bad=$((bad+1))
check "markdown has the summary table"       'py grep -q "^| pool-one | 31 / 29 |" /tmp/r.md'
check "markdown has the de-duplication table" 'py grep -q "^| 2030-01-01 | pool-one | \*all\* | 59 | 30 | 29 | 29 | 0 |" /tmp/r.md'
check "--pool filters"                       'rc --since 2030-01-01T00:00:00Z --until 2030-01-01T01:00:00Z --pool pool-two | grep -q "pool-two" && ! rc --since 2030-01-01T00:00:00Z --until 2030-01-01T01:00:00Z --pool pool-two | grep -q "pool-one"'
check "an empty window reports nothing"      'rc --since 2031-01-01T00:00:00Z --until 2031-01-02T00:00:00Z | grep -q "No pool has templates"'
check "no extranonce1 value in the output"   '! py grep -q -e 01020304 -e 05060708 /tmp/r.json /tmp/r.md'
check "stratum_web cannot write"            '! docker exec -e PGUSER=t_web -e PGPASSWORD=x "$PY" python -c "import psycopg; psycopg.connect().execute(\"DELETE FROM sources\")"'

echo "== $ok passed, $bad failed"
[ "$bad" = 0 ]
