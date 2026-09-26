-- Tenant isolation with PostgreSQL Row-Level Security.
--
-- Roles
--   * Migrations run as the database owner (DATABASE_MIGRATION_URL).
--   * The API and workers connect as a LOGIN role that is a member of "app_user"
--     (DATABASE_URL). app_user is not the table owner and has no BYPASSRLS, so every
--     query is filtered by the tenant set for the current transaction:
--         SELECT set_config('app.tenant_id', '<uuid>', true);
--     If app.tenant_id is not set, tenant tables return no rows.
--   * Queries that must run before a tenant is known (phone routing, login,
--     API-key auth, accepting an invitation) go through the SECURITY DEFINER
--     functions at the bottom of this file, which each return only the few columns needed.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON "_prisma_migrations" FROM app_user;
  END IF;
END
$$;

-- Current tenant (NULL when unset → policies match nothing)
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- Tenant row: visible only to itself
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenants"
  USING ("id" = app_current_tenant())
  WITH CHECK ("id" = app_current_tenant());

-- Every tenant-owned table gets the same policy
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'roles', 'memberships', 'invitations', 'api_keys',
    'agents', 'agent_versions', 'phone_numbers',
    'knowledge_collections', 'agent_collections', 'documents', 'document_agents', 'document_chunks',
    'integrations', 'agent_tools',
    'calls', 'call_events', 'lead_statuses', 'leads', 'appointments',
    'usage_records', 'audit_logs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t
    );
  END LOOP;
END
$$;

-- users / refresh_tokens are global (a user can belong to many tenants) and are only
-- accessed by the auth module with the user id from a verified credential.

-- ───────── Pre-tenant lookups (SECURITY DEFINER, minimal columns) ─────────

-- Telephony: inbound "To" number → tenant + agent + published version
CREATE OR REPLACE FUNCTION resolve_phone_number(p_e164 text)
RETURNS TABLE (tenant_id uuid, agent_id uuid, agent_version_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.tenant_id, a.id, a.published_version_id
  FROM phone_numbers p
  JOIN tenants t ON t.id = p.tenant_id AND t.status = 'ACTIVE'
  LEFT JOIN agents a ON a.id = p.agent_id AND a.status = 'ACTIVE'
  WHERE p.e164 = p_e164 AND p.is_active
$$;

-- Login / tenant switcher: the tenants a user belongs to
CREATE OR REPLACE FUNCTION user_memberships(p_user_id uuid)
RETURNS TABLE (tenant_id uuid, tenant_name text, tenant_slug text, role_key text, permissions text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.name::text, t.slug::text, r.key::text, r.permissions
  FROM memberships m
  JOIN tenants t ON t.id = m.tenant_id AND t.status = 'ACTIVE'
  JOIN roles r ON r.id = m.role_id
  WHERE m.user_id = p_user_id
$$;

-- API-key authentication by hash
CREATE OR REPLACE FUNCTION resolve_api_key(p_key_hash text)
RETURNS TABLE (api_key_id uuid, tenant_id uuid, scopes text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT k.id, k.tenant_id, k.scopes
  FROM api_keys k
  JOIN tenants t ON t.id = k.tenant_id AND t.status = 'ACTIVE'
  WHERE k.key_hash = p_key_hash
    AND k.revoked_at IS NULL
    AND (k.expires_at IS NULL OR k.expires_at > now())
$$;

-- Accepting an invitation by token hash
CREATE OR REPLACE FUNCTION resolve_invitation(p_token_hash text)
RETURNS TABLE (invitation_id uuid, tenant_id uuid, email text, role_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.id, i.tenant_id, i.email::text, i.role_id
  FROM invitations i
  WHERE i.token_hash = p_token_hash
    AND i.accepted_at IS NULL
    AND i.expires_at > now()
$$;

REVOKE ALL ON FUNCTION resolve_phone_number(text), user_memberships(uuid),
                       resolve_api_key(text), resolve_invitation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_current_tenant(), resolve_phone_number(text), user_memberships(uuid),
                          resolve_api_key(text), resolve_invitation(text) TO app_user;
