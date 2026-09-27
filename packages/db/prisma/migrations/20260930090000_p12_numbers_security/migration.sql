
-- AlterTable
ALTER TABLE "calls" ADD COLUMN     "connection" VARCHAR(10) NOT NULL DEFAULT 'TWILIO',
ADD COLUMN     "forwarded_from" VARCHAR(20);

-- AlterTable
ALTER TABLE "phone_numbers" ADD COLUMN     "carrier" VARCHAR(30),
ADD COLUMN     "forwarded_from" VARCHAR(20),
ADD COLUMN     "forwarding_mode" VARCHAR(40),
ADD COLUMN     "last_call_at" TIMESTAMPTZ(3),
ADD COLUMN     "max_concurrent_calls" INTEGER,
ADD COLUMN     "sip_trunk_id" UUID,
ADD COLUMN     "verification" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "verification_expires_at" TIMESTAMPTZ(3),
ADD COLUMN     "verification_status" VARCHAR(10) NOT NULL DEFAULT 'NONE',
ADD COLUMN     "verified_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "calling_code" VARCHAR(4) NOT NULL DEFAULT '91',
ADD COLUMN     "country" VARCHAR(2) NOT NULL DEFAULT 'IN',
ADD COLUMN     "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
ADD COLUMN     "max_call_minutes" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "retention_days" INTEGER NOT NULL DEFAULT 365;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "totp_enabled_at" TIMESTAMPTZ(3),
ADD COLUMN     "totp_recovery_hashes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "sip_trunks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "carrier" VARCHAR(30) NOT NULL,
    "domain_name" VARCHAR(63) NOT NULL,
    "allowed_ips" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "auth_username" VARCHAR(40),
    "auth_secret_enc" BYTEA,
    "twilio_domain_sid" VARCHAR(40),
    "twilio_ip_acl_sid" VARCHAR(40),
    "twilio_cred_list_sid" VARCHAR(40),
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING_SETUP',
    "last_error" TEXT,
    "last_call_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sip_trunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocked_callers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "pattern" VARCHAR(21) NOT NULL,
    "reason" VARCHAR(200),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocked_callers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_alerts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "dedupe_key" VARCHAR(120) NOT NULL,
    "message" VARCHAR(500) NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMPTZ(3),

    CONSTRAINT "tenant_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sip_trunks_domain_name_key" ON "sip_trunks"("domain_name");

-- CreateIndex
CREATE UNIQUE INDEX "sip_trunks_tenant_id_name_key" ON "sip_trunks"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "blocked_callers_tenant_id_pattern_key" ON "blocked_callers"("tenant_id", "pattern");

-- CreateIndex
CREATE INDEX "tenant_alerts_tenant_id_acknowledged_at_idx" ON "tenant_alerts"("tenant_id", "acknowledged_at");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_alerts_tenant_id_dedupe_key_key" ON "tenant_alerts"("tenant_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "phone_numbers_forwarded_from_key" ON "phone_numbers"("forwarded_from");

-- CreateIndex
CREATE INDEX "phone_numbers_sip_trunk_id_idx" ON "phone_numbers"("sip_trunk_id");

-- AddForeignKey
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_sip_trunk_id_fkey" FOREIGN KEY ("sip_trunk_id") REFERENCES "sip_trunks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sip_trunks" ADD CONSTRAINT "sip_trunks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocked_callers" ADD CONSTRAINT "blocked_callers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_alerts" ADD CONSTRAINT "tenant_alerts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ───────── Row-level security for the new tenant tables ─────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sip_trunks', 'blocked_callers', 'tenant_alerts']
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

-- ───────── Pre-tenant lookups (SECURITY DEFINER, minimal columns) ─────────

-- Twilio numbers: the webhook's "To" → tenant, agent, published version and the number's row.
-- SIP numbers are only reachable through their trunk's domain (resolve_sip_trunk).
DROP FUNCTION IF EXISTS resolve_phone_number(text);
CREATE FUNCTION resolve_phone_number(p_e164 text)
RETURNS TABLE (tenant_id uuid, agent_id uuid, agent_version_id uuid, phone_number_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.tenant_id, a.id, a.published_version_id, p.id
  FROM phone_numbers p
  JOIN tenants t ON t.id = p.tenant_id AND t.status = 'ACTIVE'
  LEFT JOIN agents a ON a.id = p.agent_id AND a.status = 'ACTIVE'
  WHERE p.e164 = p_e164 AND p.is_active AND p.provider = 'TWILIO'
$$;

-- SIP calls: the SIP domain they arrived on → the trunk and its business (the dialled number is
-- then read under that tenant's RLS)
CREATE FUNCTION resolve_sip_trunk(p_domain text)
RETURNS TABLE (tenant_id uuid, sip_trunk_id uuid, calling_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.tenant_id, s.id, t.calling_code::text
  FROM sip_trunks s
  JOIN tenants t ON t.id = s.tenant_id AND t.status = 'ACTIVE'
  WHERE s.domain_name = p_domain AND s.status <> 'DISABLED'
$$;

-- Nightly jobs (retention purge, alerts): every active tenant and its retention setting
CREATE FUNCTION active_tenants()
RETURNS TABLE (tenant_id uuid, retention_days int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, retention_days FROM tenants WHERE status = 'ACTIVE'
$$;

REVOKE ALL ON FUNCTION resolve_phone_number(text), resolve_sip_trunk(text), active_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_phone_number(text), resolve_sip_trunk(text), active_tenants() TO app_user;
