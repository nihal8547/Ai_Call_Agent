import { Injectable, Logger } from "@nestjs/common";
import { Prisma, resolveWhatsAppNumber, type TenantTx } from "@platform/db";
import { type InboundMessage, type StatusUpdate, waIdToE164, type WebhookEvent } from "@platform/whatsapp";
import { PrismaService } from "../../infra/prisma.service";
import { TenantDbService } from "../../infra/tenant-db.service";
import { MetricsService } from "../../observability/metrics.service";

/** A short line for the Inbox list */
export function previewOf(m: { type: string; text: string | null; mediaFilename?: string | null }): string {
  const label: Record<string, string> = {
    AUDIO: "Voice message",
    IMAGE: "Photo",
    VIDEO: "Video",
    DOCUMENT: "Document",
    STICKER: "Sticker",
    LOCATION: "Location",
    CONTACTS: "Contact",
    REACTION: "Reaction",
    TEMPLATE: "Template",
    UNSUPPORTED: "Unsupported message",
  };
  const text = m.text?.replace(/\s+/g, " ").trim();
  if (m.type === "TEXT" || m.type === "INTERACTIVE") return (text ?? "").slice(0, 200);
  const base =
    m.type === "DOCUMENT" && m.mediaFilename ? `Document: ${m.mediaFilename}` : (label[m.type] ?? m.type);
  return (text ? `${base}: ${text}` : base).slice(0, 200);
}

const STATUS_RANK = { QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3 } as const;

export type StoredInbound = { tenantId: string; conversationId: string; messageId: string };

/**
 * Webhook events into the database. Runs before the business is known: the phone_number_id is
 * resolved through the SECURITY DEFINER lookup, then everything happens under that business's RLS.
 */
@Injectable()
export class WhatsAppInboundService {
  private readonly logger = new Logger(WhatsAppInboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDbService,
    private readonly metrics: MetricsService,
  ) {}

  async handle(events: WebhookEvent[]): Promise<StoredInbound[]> {
    const stored: StoredInbound[] = [];
    for (const e of events) {
      const route = await resolveWhatsAppNumber(this.prisma.client, e.phoneNumberId);
      if (!route) {
        this.logger.warn(
          { phoneNumberId: e.phoneNumberId, kind: e.kind },
          "WhatsApp event for an unknown number",
        );
        this.metrics.whatsapp.inc({ event: e.kind, result: "unknown_number" });
        continue;
      }
      if (e.kind === "message") {
        const s = await this.message(route, e);
        this.metrics.whatsapp.inc({ event: "message", result: s ? "stored" : "duplicate" });
        if (s) stored.push(s);
      } else {
        await this.tenantDb.tx(route.tenantId, (tx) => this.status(tx, e));
        this.metrics.whatsapp.inc({ event: "status", result: e.status });
      }
    }
    return stored;
  }

  private async message(
    route: {
      tenantId: string;
      whatsappNumberId: string;
      agentId: string | null;
      agentVersionId: string | null;
    },
    e: InboundMessage,
  ): Promise<StoredInbound | null> {
    try {
      return await this.tenantDb.tx(route.tenantId, async (tx) => {
        // One customer's messages arrive together: serialise so they land in one conversation
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${route.whatsappNumberId}:${e.from}`}))`;
        if (await tx.conversationMessage.findUnique({ where: { wamid: e.wamid }, select: { id: true } }))
          return null; // Meta retried the webhook

        const open = await tx.conversation.findFirst({
          where: { whatsappNumberId: route.whatsappNumberId, contactWaId: e.from, mode: { not: "CLOSED" } },
          orderBy: { createdAt: "desc" },
        });
        const conversation =
          open ??
          (await tx.conversation.create({
            data: {
              tenantId: route.tenantId,
              whatsappNumberId: route.whatsappNumberId,
              agentId: route.agentId,
              agentVersionId: route.agentVersionId,
              contactWaId: e.from,
              contactPhone: waIdToE164(e.from).slice(0, 20),
              contactName: e.profileName?.slice(0, 160) ?? null,
            },
          }));

        const message = await tx.conversationMessage.create({
          data: {
            tenantId: route.tenantId,
            conversationId: conversation.id,
            wamid: e.wamid,
            direction: "INBOUND",
            sender: "CUSTOMER",
            type: e.type,
            text: e.text,
            mediaId: e.media?.id ?? null,
            mediaMime: e.media?.mimeType.slice(0, 100) ?? null,
            mediaFilename: e.media?.filename?.slice(0, 255) ?? null,
            replyToWamid: e.replyTo,
            status: "RECEIVED",
            sentAt: e.timestamp,
            meta: e.media?.voice ? { voice: true } : {},
          },
        });

        const lastInbound =
          conversation.lastInboundAt && conversation.lastInboundAt > e.timestamp
            ? conversation.lastInboundAt
            : e.timestamp;
        await tx.conversation.update({
          where: { id: conversation.id },
          data: {
            lastInboundAt: lastInbound,
            lastMessageAt: new Date(),
            lastMessagePreview: previewOf({ type: e.type, text: e.text, mediaFilename: e.media?.filename }),
            unreadCount: { increment: 1 },
            ...(e.profileName ? { contactName: e.profileName.slice(0, 160) } : {}),
          },
        });
        return { tenantId: route.tenantId, conversationId: conversation.id, messageId: message.id };
      });
    } catch (err) {
      // Two deliveries of the same message raced past the check: the unique wamid keeps one
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null;
      throw err;
    }
  }

  /** Delivery ticks never go backwards (Meta can deliver "delivered" after "read") */
  private async status(tx: TenantTx, e: StatusUpdate): Promise<void> {
    const m = await tx.conversationMessage.findUnique({ where: { wamid: e.wamid } });
    if (!m || m.direction !== "OUTBOUND") return;
    if (e.status === "failed") {
      await tx.conversationMessage.update({
        where: { id: m.id },
        data: {
          status: "FAILED",
          errorCode: e.error?.code ?? null,
          errorTitle: (e.error
            ? [e.error.title, e.error.detail].filter(Boolean).join(": ")
            : "Delivery failed"
          ).slice(0, 300),
        },
      });
      return;
    }
    const next = e.status.toUpperCase() as "SENT" | "DELIVERED" | "READ";
    const current = m.status in STATUS_RANK ? STATUS_RANK[m.status as keyof typeof STATUS_RANK] : 99;
    if (STATUS_RANK[next] <= current) return;
    await tx.conversationMessage.update({
      where: { id: m.id },
      data: {
        status: next,
        ...(next === "DELIVERED" ? { deliveredAt: e.timestamp } : {}),
        ...(next === "READ" ? { readAt: e.timestamp, deliveredAt: m.deliveredAt ?? e.timestamp } : {}),
      },
    });
  }
}
