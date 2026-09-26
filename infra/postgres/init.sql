-- Runs once when the local Postgres volume is created.
-- voice_owner (POSTGRES_USER) owns the schema and runs migrations.
-- voice_app is the runtime login; it gets app_user privileges (created by the RLS migration),
-- so Row-Level Security applies to everything the API and workers do.
CREATE ROLE app_user NOLOGIN NOBYPASSRLS;
CREATE ROLE voice_app LOGIN PASSWORD 'voice_app' IN ROLE app_user;

-- Separate database for `prisma migrate dev` shadow and for integration tests
CREATE DATABASE voice_shadow OWNER voice_owner;
CREATE DATABASE voice_test OWNER voice_owner;
