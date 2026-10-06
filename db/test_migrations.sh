#!/usr/bin/env bash
# db/test_migrations.sh — applies migrations twice (idempotence) and checks objects exist.
set -euo pipefail
if [ -z "${TEST_DATABASE_URL:-}" ]; then echo "SKIP: TEST_DATABASE_URL not set"; exit 0; fi
DATABASE_URL="$TEST_DATABASE_URL" "$(dirname "$0")/migrate.sh"
DATABASE_URL="$TEST_DATABASE_URL" "$(dirname "$0")/migrate.sh"
for t in templates shares routing blocks pools shares_minutely; do
  psql "$TEST_DATABASE_URL" -tA -c "SELECT to_regclass('$t')" | grep -q "$t" || { echo "missing $t"; exit 1; }
done
n="$(psql "$TEST_DATABASE_URL" -tA -c "SELECT count(*) FROM schema_migrations")"
[ "$n" = "3" ] || { echo "expected 3 schema_migrations rows, got $n"; exit 1; }
echo OK
