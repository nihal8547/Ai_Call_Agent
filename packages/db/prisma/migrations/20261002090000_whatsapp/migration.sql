-- CreateEnum
CREATE TYPE "WhatsAppNumberStatus" AS ENUM ('CONNECTED', 'PENDING', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "ConversationMode" AS ENUM ('AI', 'HUMAN', 'CLOSED');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND', 'INTERNAL');

-- CreateEnum
CREATE TYPE "MessageSender" AS ENUM ('CUSTOMER', 'AI', 'STAFF', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ConversationMessageType" AS ENUM ('TEXT', 'AUDIO', 'IMAGE', 'DOCUMENT', 'VIDEO', 'STICKER', 'LOCATION', 'CONTACTS', 'INTERACTIVE', 'REACTION', 'TEMPLATE', 'NOTE', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "ConversationMessageStatus" AS ENUM ('RECEIVED', 'QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- DropIndex

-- CreateTable
CREATE TABLE "whatsapp_numbers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "integration_id" UUID,
    "waba_id" VARCHAR(64) NOT NULL,
    "phone_number_id" VARCHAR(64) NOT NULL,
    "display_number" VARCHAR(32) NOT NULL,
    "verified_name" VARCHAR(160),
    "agent_id" UUID,
    "status" "WhatsAppNumberStatus" NOT NULL DEFAULT 'CONNECTED',
    "quality_rating" VARCHAR(20),
    "last_error" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "connected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "whatsapp_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "whatsapp_number_id" UUID NOT NULL,
    "agent_id" UUID,
    "agent_version_id" UUID,
    "contact_wa_id" VARCHAR(32) NOT NULL,
    "contact_phone" VARCHAR(20) NOT NULL,
    "contact_name" VARCHAR(160),
    "mode" "ConversationMode" NOT NULL DEFAULT 'AI',
    "engine_session" JSONB,
    "last_inbound_at" TIMESTAMPTZ(3),
    "last_message_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_message_preview" VARCHAR(200),
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "assignee_id" UUID,
    "lead_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "wamid" VARCHAR(128),
    "direction" "MessageDirection" NOT NULL,
    "sender" "MessageSender" NOT NULL,
    "sent_by_id" UUID,
    "type" "ConversationMessageType" NOT NULL DEFAULT 'TEXT',
    "text" TEXT,
    "media_id" VARCHAR(64),
    "media_key" VARCHAR(255),
    "media_mime" VARCHAR(100),
    "media_filename" VARCHAR(255),
    "media_bytes" INTEGER,
    "media_seconds" INTEGER,
    "transcript" TEXT,
    "transcript_language" VARCHAR(10),
    "status" "ConversationMessageStatus" NOT NULL,
    "error_code" INTEGER,
    "error_title" VARCHAR(300),
    "reply_to_wamid" VARCHAR(128),
    "meta" JSONB NOT NULL DEFAULT '{}',
    "sent_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_numbers_phone_number_id_key" ON "whatsapp_numbers"("phone_number_id");

-- CreateIndex
CREATE INDEX "whatsapp_numbers_tenant_id_idx" ON "whatsapp_numbers"("tenant_id");

-- CreateIndex
CREATE INDEX "conversations_tenant_id_last_message_at_idx" ON "conversations"("tenant_id", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "conversations_tenant_id_mode_idx" ON "conversations"("tenant_id", "mode");

-- CreateIndex
CREATE INDEX "conversations_whatsapp_number_id_contact_wa_id_idx" ON "conversations"("whatsapp_number_id", "contact_wa_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_id_tenant_id_key" ON "conversations"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_messages_wamid_key" ON "conversation_messages"("wamid");

-- CreateIndex
CREATE INDEX "conversation_messages_conversation_id_created_at_idx" ON "conversation_messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "conversation_messages_tenant_id_created_at_idx" ON "conversation_messages"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_whatsapp_number_id_fkey" FOREIGN KEY ("whatsapp_number_id") REFERENCES "whatsapp_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_tenant_id_fkey" FOREIGN KEY ("conversation_id", "tenant_id") REFERENCES "conversations"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_sent_by_id_fkey" FOREIGN KEY ("sent_by_id") REFERENCES "memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ───────── Row-level security for the WhatsApp tables ─────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['whatsapp_numbers', 'conversations', 'conversation_messages']
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

-- ───────── Webhook routing before a tenant is known (SECURITY DEFINER, minimal columns) ─────────
-- Meta's phone_number_id → the business, its WhatsApp number and the agent answering it.
-- Disconnected numbers and suspended businesses are not routed.
CREATE FUNCTION resolve_whatsapp_number(p_phone_number_id text)
RETURNS TABLE (tenant_id uuid, whatsapp_number_id uuid, agent_id uuid, agent_version_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT w.tenant_id, w.id, a.id, a.published_version_id
  FROM whatsapp_numbers w
  JOIN tenants t ON t.id = w.tenant_id AND t.status = 'ACTIVE'
  LEFT JOIN agents a ON a.id = w.agent_id AND a.status = 'ACTIVE'
  WHERE w.phone_number_id = p_phone_number_id AND w.status <> 'DISCONNECTED'
$$;

REVOKE ALL ON FUNCTION resolve_whatsapp_number(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_whatsapp_number(text) TO app_user;

-- ───────── Chat permissions for existing businesses' built-in roles ─────────
-- (new businesses get them from SYSTEM_ROLES). Roles have forced RLS; lift it for this update only.
ALTER TABLE "roles" NO FORCE ROW LEVEL SECURITY;
UPDATE "roles" SET "permissions" = "permissions" || ARRAY['chats:read', 'chats:reply', 'chats:manage']
  WHERE "is_system" AND "key" IN ('OWNER', 'ADMIN') AND NOT ('chats:read' = ANY ("permissions"));
UPDATE "roles" SET "permissions" = "permissions" || ARRAY['chats:read', 'chats:reply']
  WHERE "is_system" AND "key" IN ('MANAGER', 'STAFF') AND NOT ('chats:read' = ANY ("permissions"));
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
