#!/bin/sh
# Runs once when the Postgres volume is created (docker-entrypoint-initdb.d).
# voice_owner (POSTGRES_USER) owns the schema and runs migrations. The app logs in as voice_app,
# a member of app_user (no BYPASSRLS), so Row-Level Security applies to everything it does.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}" <<'SQL'
CREATE ROLE app_user NOLOGIN NOBYPASSRLS;
CREATE ROLE voice_app LOGIN PASSWORD :'app_password' IN ROLE app_user;
SQL
