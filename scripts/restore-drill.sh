#!/usr/bin/env bash
# Restore drill: prove a backup can actually be restored and used. Restores into a scratch
# database next to the source, then checks migrations, row counts, tenant isolation (RLS) and
# that the app role sees nothing without a tenant. Drops the scratch database unless KEEP=1.
# Usage: DATABASE_MIGRATION_URL=... scripts/restore-drill.sh backups/voice-….dump
set -euo pipefail
: "${DATABASE_MIGRATION_URL:?set DATABASE_MIGRATION_URL (the owner connection)}"
dump="${1:?path to a .dump from scripts/backup.sh}"
started=$(date +%s)
[[ -f "$dump.sha256" ]] && sha256sum --check --quiet "$dump.sha256"

scratch="voice_restore_drill_$(date +%s)"
admin_url="${DATABASE_MIGRATION_URL%/*}/postgres"
scratch_url="${DATABASE_MIGRATION_URL%/*}/$scratch"
psql -q "$admin_url" -c "CREATE DATABASE $scratch"
cleanup() { [[ "${KEEP:-0}" == 1 ]] || psql -q "$admin_url" -c "DROP DATABASE IF EXISTS $scratch WITH (FORCE)"; }
trap cleanup EXIT

pg_restore --no-owner --exit-on-error --dbname "$scratch_url" "$dump"

q() { psql -Atq "$1" -c "$2"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

migrations_dir="$(dirname "$0")/../packages/db/prisma/migrations"
expected=$(find "$migrations_dir" -mindepth 1 -maxdepth 1 -type d | wc -l)
applied=$(q "$scratch_url" "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL")
[[ "$applied" -le "$expected" && "$applied" -gt 0 ]] || fail "migrations: $applied applied, $expected in the repo"

for t in tenants users calls call_events leads documents document_chunks integrations usage_records; do
  src=$(q "$DATABASE_MIGRATION_URL" "SELECT count(*) FROM $t")
  dst=$(q "$scratch_url" "SELECT count(*) FROM $t")
  # The live database may have moved on since the dump; the copy must never have more
  [[ "$dst" -le "$src" ]] || fail "$t: $dst rows restored, $src in the source"
  echo "  $t: $dst rows"
done

unprotected=$(q "$scratch_url" "SELECT string_agg(c.relname, ', ') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND EXISTS (SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = c.relname AND column_name = 'tenant_id') AND NOT c.relforcerowsecurity")
[[ -z "$unprotected" ]] || fail "tables restored without forced RLS: $unprotected"

visible=$(q "$scratch_url" "SET ROLE app_user; SELECT count(*) FROM calls")
[[ "$visible" == 0 ]] || fail "the app role sees $visible calls without a tenant"

echo "Restore drill passed in $(( $(date +%s) - started ))s: $dump → $scratch"
