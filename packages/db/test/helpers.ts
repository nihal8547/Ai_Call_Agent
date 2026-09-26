import { randomBytes, randomUUID } from "node:crypto";
import { createPrismaClient } from "../src/client";
import { provisionTenant } from "../src/provisioning";
import { withTenant } from "../src/tenant-client";

export const ownerUrl = process.env.TEST_DATABASE_URL;
export const appUrl = process.env.TEST_APP_DATABASE_URL;
export const hasDb = Boolean(ownerUrl && appUrl);

export const masterKey = randomBytes(32);

/** Every table that belongs to a tenant, with the column that holds the tenant id */
export const TENANT_TABLES: { table: string; column: string }[] = [
  { table: "tenants", column: "id" },
  ...[
    "roles",
    "memberships",
    "invitations",
    "api_keys",
    "agents",
    "agent_versions",
    "phone_numbers",
    "knowledge_collections",
    "agent_collections",
    "documents",
    "document_agents",
    "document_chunks",
    "integrations",
    "agent_tools",
    "calls",
    "call_events",
    "lead_statuses",
    "leads",
    "appointments",
    "usage_records",
    "audit_logs",
    "failed_jobs",
    "analytics_hourly",
  ].map((table) => ({ table, column: "tenant_id" })),
];

export function appClient() {
  return createPrismaClient({ url: appUrl, log: [] });
}
export function ownerClient() {
  return createPrismaClient({ url: ownerUrl, log: [] });
}

/** A tenant with one row in every tenant table, created through the RLS-restricted app role */
export async function createPopulatedTenant(prisma: ReturnType<typeof appClient>, label: string) {
  const user = await prisma.user.create({
    data: { email: `${label}-${randomUUID()}@example.com`, name: label, passwordHash: "x" },
  });
  const tenant = await provisionTenant(prisma, masterKey, {
    name: `Tenant ${label}`,
    slug: `t-${label}-${randomUUID().slice(0, 8)}`,
    ownerUserId: user.id,
  });
  const tenantId = tenant.id;
  const phone = `+9199${Math.floor(Math.random() * 1e8)
    .toString()
    .padStart(8, "0")}`;

  const ids = await withTenant(prisma, tenantId, async (tx) => {
    const role = await tx.role.findFirstOrThrow({ where: { key: "STAFF" } });
    const status = await tx.leadStatus.findFirstOrThrow({ where: { isDefault: true } });
    const agent = await tx.agent.create({ data: { tenantId, name: "Agent" } });
    const version = await tx.agentVersion.create({
      data: { tenantId, agentId: agent.id, version: 1, config: {}, configHash: "h" },
    });
    await tx.phoneNumber.create({ data: { tenantId, agentId: agent.id, e164: phone } });
    const collection = await tx.knowledgeCollection.create({ data: { tenantId, name: "FAQ" } });
    await tx.agentCollection.create({ data: { tenantId, agentId: agent.id, collectionId: collection.id } });
    const doc = await tx.document.create({
      data: {
        tenantId,
        collectionId: collection.id,
        title: "Doc",
        fileName: "doc.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10n,
        storageKey: `k/${randomUUID()}`,
        checksum: randomUUID().replaceAll("-", ""),
      },
    });
    await tx.documentAgent.create({ data: { tenantId, documentId: doc.id, agentId: agent.id } });
    const vector = `[${Array.from({ length: 768 }, () => "0.01").join(",")}]`;
    await tx.$executeRaw`
      INSERT INTO document_chunks (id, tenant_id, collection_id, document_id, ordinal, content, token_count, embedding, embedding_model)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${collection.id}::uuid, ${doc.id}::uuid, 0, 'We offer dental implants.', 5, ${vector}::vector, 'test')`;
    const integration = await tx.integration.create({
      data: { tenantId, type: "WEBHOOK", name: "Hook", credentialsEncrypted: new Uint8Array([1]) },
    });
    await tx.agentTool.create({
      data: { tenantId, agentId: agent.id, toolName: "webhook.post", integrationId: integration.id },
    });
    const call = await tx.call.create({
      data: {
        tenantId,
        agentId: agent.id,
        agentVersionId: version.id,
        providerCallSid: `CA${randomUUID().replaceAll("-", "")}`,
        fromNumber: "+919800000000",
        toNumber: phone,
      },
    });
    await tx.callEvent.create({
      data: { tenantId, callId: call.id, seq: 1, type: "USER_TURN", payload: {} },
    });
    const lead = await tx.lead.create({
      data: { tenantId, callId: call.id, statusId: status.id, phone: "+919800000000" },
    });
    await tx.appointment.create({
      data: {
        tenantId,
        leadId: lead.id,
        title: "Visit",
        startsAt: new Date(Date.now() + 3600_000),
        endsAt: new Date(Date.now() + 7200_000),
        timezone: "Asia/Kolkata",
      },
    });
    await tx.usageRecord.create({
      data: { tenantId, callId: call.id, kind: "LLM_INPUT_TOKENS", quantity: 100n },
    });
    await tx.auditLog.create({
      data: { tenantId, actorType: "system", action: "test", entityType: "agent" },
    });
    await tx.failedJob.create({
      data: {
        tenantId,
        queue: "webhooks",
        name: "tool",
        jobId: `j-${randomUUID()}`,
        label: "Call a webhook",
        payload: {},
        error: "rejected",
        attempts: 1,
      },
    });
    await tx.analyticsHourly.create({
      data: { tenantId, agentId: agent.id, hour: new Date("2026-09-28T10:00:00Z"), calls: 1 },
    });
    await tx.apiKey.create({
      data: { tenantId, name: "key", prefix: "vk_test", keyHash: randomUUID(), scopes: ["calls:read"] },
    });
    await tx.invitation.create({
      data: {
        tenantId,
        email: `${label}-invite@example.com`,
        roleId: role.id,
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 86400_000),
      },
    });
    return { agentId: agent.id, leadId: lead.id, collectionId: collection.id, phone };
  });

  return { tenantId, userId: user.id, ...ids };
}
