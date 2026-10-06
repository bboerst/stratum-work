#!/usr/bin/env bash
# db/migrate.sh — applies db/migrations/*.sql once each, in lexical order.
# Files whose first line is "-- no-transaction" run without a wrapping transaction.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
DIR="${MIGRATIONS_DIR:-$(dirname "$0")/migrations}"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
for f in "$DIR"/*.sql; do
  v="$(basename "$f" .sql)"
  if [ "$(psql "$DATABASE_URL" -tA -c "SELECT 1 FROM schema_migrations WHERE version = '$v'")" = "1" ]; then
    continue
  fi
  echo "applying $v"
  if head -1 "$f" | grep -q -- '-- no-transaction'; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
  else
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -1 -f "$f"
  fi
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "INSERT INTO schema_migrations (version) VALUES ('$v')"
done
