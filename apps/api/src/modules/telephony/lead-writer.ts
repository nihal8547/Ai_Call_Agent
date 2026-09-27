import type { TenantTx } from "@platform/db";
import type { AgentConfig } from "@platform/shared";

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type LeadSource = {
  tenantId: string;
  /** The call the lead came from, or null for a WhatsApp conversation */
  callId: string | null;
  conversationId?: string | null;
  agentId: string;
  callerNumber: string;
  collected: Record<string, unknown>;
  config: AgentConfig;
};

/**
 * Create or update the lead for a call or WhatsApp conversation. One lead per call or
 * conversation; a repeat customer within 24 hours updates their existing lead instead of
 * creating a duplicate.
 */
export async function upsertLeadForCall(
  tx: TenantTx,
  src: LeadSource,
): Promise<{ id: string; created: boolean }> {
  const fieldOfType = (type: string) => src.config.qualificationFields.find((f) => f.type === type)?.key;
  const pick = (type: string) => {
    const key = fieldOfType(type);
    const v = key ? src.collected[key] : undefined;
    return typeof v === "string" ? v : undefined;
  };
  const phone = pick("phone") ?? src.callerNumber;
  const customerName = pick("name");
  const email = pick("email");

  // Same call → same lead. A repeat call from the same number within 24h updates that lead only when
  // it is plausibly the same person (same name, or no name given): one phone can serve a whole family.
  const recent = await tx.lead.findFirst({
    where: { phone, createdAt: { gte: new Date(Date.now() - DEDUPE_WINDOW_MS) } },
    orderBy: { createdAt: "desc" },
  });
  const samePerson =
    recent &&
    (!customerName ||
      !recent.customerName ||
      recent.customerName.toLowerCase() === customerName.toLowerCase());
  const own = src.callId
    ? await tx.lead.findFirst({ where: { callId: src.callId } })
    : src.conversationId
      ? await tx.lead.findFirst({ where: { conversations: { some: { id: src.conversationId } } } })
      : null;
  const existing = own ?? (samePerson ? recent : null);

  if (existing) {
    if (src.conversationId && !own)
      await tx.conversation.update({ where: { id: src.conversationId }, data: { leadId: existing.id } });
    await tx.lead.update({
      where: { id: existing.id },
      data: {
        data: { ...(existing.data as Record<string, unknown>), ...src.collected } as object,
        ...(customerName ? { customerName } : {}),
        ...(email ? { email } : {}),
      },
    });
    return { id: existing.id, created: false };
  }

  const status =
    (await tx.leadStatus.findFirst({ where: { isDefault: true } })) ??
    (await tx.leadStatus.findFirstOrThrow({ orderBy: { sortOrder: "asc" } }));
  const lead = await tx.lead.create({
    data: {
      tenantId: src.tenantId,
      agentId: src.agentId,
      callId: src.callId,
      statusId: status.id,
      phone,
      customerName: customerName ?? null,
      email: email ?? null,
      source: src.conversationId ? "whatsapp" : "inbound_call",
      data: src.collected as object,
    },
  });
  if (src.conversationId)
    await tx.conversation.update({ where: { id: src.conversationId }, data: { leadId: lead.id } });
  return { id: lead.id, created: true };
}
