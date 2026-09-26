#!/usr/bin/env bash
# Fails if prisma/schema.prisma and prisma/migrations/ disagree.
#
# Prisma cannot express pgvector HNSW indexes, so the diff always proposes dropping
# the hand-written index in the init migration. That one statement is allow-listed;
# anything else means someone changed the schema without generating a migration
# (or a generated migration was edited incorrectly).
#
# Requires SHADOW_DATABASE_URL (an empty database the script may reset).
set -euo pipefail
cd "$(dirname "$0")/.."

: "${SHADOW_DATABASE_URL:?set SHADOW_DATABASE_URL to an empty scratch database}"

ALLOWED='^DROP INDEX "document_chunks_embedding_hnsw_idx";$'

PRISMA_BIN="${PRISMA_BIN:-pnpm exec prisma}"

diff_sql="$($PRISMA_BIN migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" \
  --script)"

unexpected="$(printf '%s\n' "$diff_sql" | grep -vE '^\s*$|^--' | grep -vE "$ALLOWED" || true)"

if [[ -n "$unexpected" ]]; then
  echo "Schema drift detected between schema.prisma and migrations:" >&2
  printf '%s\n' "$unexpected" >&2
  echo >&2
  echo "Run: pnpm --filter @platform/db migrate:dev --create-only --name <change>" >&2
  echo "and delete any DROP of document_chunks_embedding_hnsw_idx from the generated SQL." >&2
  exit 1
fi
echo "Migrations match schema.prisma."
