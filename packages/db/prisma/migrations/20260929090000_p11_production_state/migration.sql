-- CreateEnum
CREATE TYPE "FailedJobStatus" AS ENUM ('FAILED', 'RETRIED', 'DISMISSED');

-- AlterTable
ALTER TABLE "calls" ADD COLUMN     "session_snapshot" JSONB;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "crm_sync" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "failed_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "queue" VARCHAR(40) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "job_id" VARCHAR(200) NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "payload" JSONB NOT NULL,
    "error" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "call_id" UUID,
    "lead_id" UUID,
    "integration_id" UUID,
    "status" "FailedJobStatus" NOT NULL DEFAULT 'FAILED',
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "failed_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_hourly" (
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "hour" TIMESTAMP(0) NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "answered" INTEGER NOT NULL DEFAULT 0,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "qualified" INTEGER NOT NULL DEFAULT 0,
    "disqualified" INTEGER NOT NULL DEFAULT 0,
    "lead_captured" INTEGER NOT NULL DEFAULT 0,
    "booked" INTEGER NOT NULL DEFAULT 0,
    "enquiry_answered" INTEGER NOT NULL DEFAULT 0,
    "handoff" INTEGER NOT NULL DEFAULT 0,
    "follow_up" INTEGER NOT NULL DEFAULT 0,
    "abandoned" INTEGER NOT NULL DEFAULT 0,
    "duration_sec" INTEGER NOT NULL DEFAULT 0,
    "turns" INTEGER NOT NULL DEFAULT 0,
    "fallback_turns" INTEGER NOT NULL DEFAULT 0,
    "transfers_missed" INTEGER NOT NULL DEFAULT 0,
    "questions" INTEGER NOT NULL DEFAULT 0,
    "questions_answered" INTEGER NOT NULL DEFAULT 0,
    "tool_runs" INTEGER NOT NULL DEFAULT 0,
    "tool_failures" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "fields" JSONB NOT NULL DEFAULT '{}',
    "tools" JSONB NOT NULL DEFAULT '{}',
    "latency" JSONB NOT NULL DEFAULT '{}',
    "rag_reasons" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_hourly_pkey" PRIMARY KEY ("tenant_id","agent_id","hour")
);

-- CreateIndex
CREATE INDEX "failed_jobs_tenant_id_status_created_at_idx" ON "failed_jobs"("tenant_id", "status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "failed_jobs_queue_job_id_key" ON "failed_jobs"("queue", "job_id");

-- CreateIndex
CREATE INDEX "analytics_hourly_tenant_id_hour_idx" ON "analytics_hourly"("tenant_id", "hour");

-- AddForeignKey
ALTER TABLE "failed_jobs" ADD CONSTRAINT "failed_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_hourly" ADD CONSTRAINT "analytics_hourly_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_hourly" ADD CONSTRAINT "analytics_hourly_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ───────── Row-level security for the new tenant tables ─────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['failed_jobs', 'analytics_hourly']
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

-- Telephony: recover a live call's state by the provider's call id when Redis lost it.
-- Only calls still in progress (snapshot present) and started in the last few hours.
CREATE OR REPLACE FUNCTION resolve_call_snapshot(p_call_sid text)
RETURNS TABLE (tenant_id uuid, snapshot jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.tenant_id, c.session_snapshot
  FROM calls c
  JOIN tenants t ON t.id = c.tenant_id AND t.status = 'ACTIVE'
  WHERE c.provider_call_sid = p_call_sid
    AND c.session_snapshot IS NOT NULL
    AND c.started_at > now() - interval '4 hours'
$$;

-- Analytics roll-ups: which tenants had calls since a moment (the sweep then works per tenant)
CREATE OR REPLACE FUNCTION tenants_with_calls_since(p_since timestamptz)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT c.tenant_id
  FROM calls c
  JOIN tenants t ON t.id = c.tenant_id AND t.status = 'ACTIVE'
  WHERE c.started_at >= p_since OR c.ended_at >= p_since
$$;

REVOKE ALL ON FUNCTION resolve_call_snapshot(text), tenants_with_calls_since(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_call_snapshot(text), tenants_with_calls_since(timestamptz) TO app_user;
