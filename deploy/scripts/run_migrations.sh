#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env.production}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -n "${DATABASE_URL:-}" ]]; then
  DB_TARGET="$DATABASE_URL"
else
  DB_TARGET="${PGDATABASE:-smartai}"
fi

psql -v ON_ERROR_STOP=1 "$DB_TARGET" \
  -f "$PROJECT_DIR/db/migrations/001_initial_schema.sql" \
  -f "$PROJECT_DIR/db/migrations/002_google_oauth_and_chat_delete.sql"
