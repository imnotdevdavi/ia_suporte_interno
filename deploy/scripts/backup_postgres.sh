#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/smartai}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
TIMESTAMP="$(date +%F-%H%M%S)"

mkdir -p "$BACKUP_DIR"

if [[ -n "${DATABASE_URL:-}" ]]; then
  TARGET="$DATABASE_URL"
else
  TARGET="${PGDATABASE:-smartai}"
fi

OUTPUT_FILE="$BACKUP_DIR/smartai-${TIMESTAMP}.dump"

pg_dump -Fc "$TARGET" > "$OUTPUT_FILE"
find "$BACKUP_DIR" -type f -name 'smartai-*.dump' -mtime +"$RETENTION_DAYS" -delete

echo "Backup criado em $OUTPUT_FILE"
