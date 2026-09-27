#!/usr/bin/env bash
# Full database backup (schema, RLS policies, data) in pg_dump's custom format, with a checksum.
# Usage: DATABASE_MIGRATION_URL=postgresql://owner@host/db scripts/backup.sh [out-dir]
# Managed Postgres (RDS, Cloud SQL, Neon) also keeps its own point-in-time backups: this is the
# portable copy you can restore anywhere, and the input to scripts/restore-drill.sh.
set -euo pipefail
: "${DATABASE_MIGRATION_URL:?set DATABASE_MIGRATION_URL (the owner connection)}"
out="${1:-backups}"
mkdir -p "$out"
file="$out/voice-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --compress=6 --no-owner "$DATABASE_MIGRATION_URL" --file "$file"
sha256sum "$file" > "$file.sha256"
echo "$file ($(du -h "$file" | cut -f1))"
