-- Connection health, WhatsApp Business app numbers (coexistence) and account-level webhooks
ALTER TABLE "whatsapp_numbers"
  ADD COLUMN "on_business_app" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "messaging_limit" VARCHAR(32),
  ADD COLUMN "last_webhook_at" TIMESTAMPTZ(3),
  ADD COLUMN "health" JSONB NOT NULL DEFAULT '{}';

-- Account webhooks (account_update, phone_number_quality_update) name the WhatsApp Business
-- account, not a number: WABA id → the businesses' numbers in it (connected or pending).
CREATE FUNCTION resolve_whatsapp_waba(p_waba_id text)
RETURNS TABLE (tenant_id uuid, whatsapp_number_id uuid, display_number text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT w.tenant_id, w.id, w.display_number
  FROM whatsapp_numbers w
  JOIN tenants t ON t.id = w.tenant_id AND t.status = 'ACTIVE'
  WHERE w.waba_id = p_waba_id AND w.status <> 'DISCONNECTED'
$$;

REVOKE ALL ON FUNCTION resolve_whatsapp_waba(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_whatsapp_waba(text) TO app_user;

-- A number disconnected by one business stays on its row (with the history) but must not block
-- another business from connecting it: its phone_number_id is moved aside. Only DISCONNECTED rows.
CREATE FUNCTION release_whatsapp_number(p_phone_number_id text)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n integer;
BEGIN
  UPDATE whatsapp_numbers
    SET phone_number_id = left(phone_number_id || '~' || replace(id::text, '-', ''), 64)
    WHERE phone_number_id = p_phone_number_id AND status = 'DISCONNECTED';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

REVOKE ALL ON FUNCTION release_whatsapp_number(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION release_whatsapp_number(text) TO app_user;

-- ───────── SECURITY DEFINER lookups on managed Postgres ─────────
-- The lookups (phone and WhatsApp routing, sign-in, API keys …) run as the schema owner. Tables
-- have FORCE ROW LEVEL SECURITY, which filters the owner too unless it is a superuser: true in
-- local Docker, not on managed Postgres (RDS, Cloud SQL, Azure), where the lookups found nothing.
-- The owner (the migration role) may see every row; the runtime role stays isolated. Skipped if
-- the migration role is itself a member of app_user (then this would open the runtime's access).
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles r ON r.oid = m.roleid AND r.rolname = 'app_user'
    JOIN pg_roles u ON u.oid = m.member AND u.rolname = current_user
  ) THEN
    RAISE WARNING 'Migrations run as a member of app_user: owner_access policies not created';
    RETURN;
  END IF;
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'owner_access'
    ) THEN
      EXECUTE format('CREATE POLICY owner_access ON %I TO %I USING (true) WITH CHECK (true)', t, current_user);
    END IF;
  END LOOP;
END
$$;
