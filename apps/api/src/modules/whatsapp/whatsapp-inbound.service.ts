import { Injectable, Logger } from "@nestjs/common";
import {
  Prisma,
  resolveWhatsAppNumber,
  resolveWhatsAppWaba,
  type TenantTx,
  type WhatsAppRoute,
} from "@platform/db";
import {
  type AccountUpdate,
  type EchoMessage,
  type InboundMessage,
  type QualityUpdate,
  type StatusUpdate,
  waIdToE164,
  type WebhookEvent,
} from "@platform/whatsapp";
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

/** A conversation without messages for this long is closed when the customer writes again */
export const IDLE_CLOSE_MS = 24 * 60 * 60 * 1000;

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
    /** Numbers Meta told us about in this delivery (tenant → number ids), for "last webhook" */
    const seen = new Map<string, Set<string>>();
    for (const e of events) {
      if (e.kind === "account" || e.kind === "quality") {
        await this.accountNews(e);
        continue;
      }
      const route = await resolveWhatsAppNumber(this.prisma.client, e.phoneNumberId);
      if (!route) {
        this.logger.warn(
          { phoneNumberId: e.phoneNumberId, kind: e.kind },
          "WhatsApp event for an unknown number",
        );
        this.metrics.whatsapp.inc({ event: e.kind, result: "unknown_number" });
        continue;
      }
      (seen.get(route.tenantId) ?? seen.set(route.tenantId, new Set()).get(route.tenantId)!).add(
        route.whatsappNumberId,
      );
      if (e.kind === "message") {
        const s = await this.message(route, e);
        this.metrics.whatsapp.inc({ event: "message", result: s ? "stored" : "duplicate" });
        if (s) stored.push(s);
      } else if (e.kind === "echo") {
        const s = await this.echo(route, e);
        this.metrics.whatsapp.inc({ event: "echo", result: s ? "stored" : "duplicate" });
      } else {
        await this.tenantDb.tx(route.tenantId, (tx) => this.status(tx, e));
        this.metrics.whatsapp.inc({ event: "status", result: e.status });
      }
    }
    // Proof that webhooks arrive, for the number's connection check (at most every 30 s)
    for (const [tenantId, ids] of seen)
      await this.tenantDb
        .db(tenantId)
        .whatsAppNumber.updateMany({
          where: {
            id: { in: [...ids] },
            OR: [{ lastWebhookAt: null }, { lastWebhookAt: { lt: new Date(Date.now() - 30_000) } }],
          },
          data: { lastWebhookAt: new Date() },
        })
        .catch(() => undefined);
    return stored;
  }

  /** The open conversation with this customer (a day of silence closes it and starts a new one) */
  private async openConversation(
    tx: TenantTx,
    route: WhatsAppRoute,
    waId: string,
    profileName: string | null,
  ) {
    let open = await tx.conversation.findFirst({
      where: { whatsappNumberId: route.whatsappNumberId, contactWaId: waId, mode: { not: "CLOSED" } },
      orderBy: { createdAt: "desc" },
    });
    if (open && open.lastMessageAt.getTime() < Date.now() - IDLE_CLOSE_MS) {
      await tx.conversation.update({
        where: { id: open.id },
        data: { mode: "CLOSED", closedAt: new Date() },
      });
      await note(tx, route.tenantId, open.id, "Closed after 24 hours without messages");
      open = null;
    }
    return (
      open ??
      tx.conversation.create({
        data: {
          tenantId: route.tenantId,
          whatsappNumberId: route.whatsappNumberId,
          agentId: route.agentId,
          agentVersionId: route.agentVersionId,
          contactWaId: waId,
          contactPhone: waIdToE164(waId).slice(0, 20),
          contactName: profileName?.slice(0, 160) ?? null,
        },
      })
    );
  }

  private async message(route: WhatsAppRoute, e: InboundMessage): Promise<StoredInbound | null> {
    try {
      return await this.tenantDb.tx(route.tenantId, async (tx) => {
        // One customer's messages arrive together: serialise so they land in one conversation
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${route.whatsappNumberId}:${e.from}`}))`;
        if (await tx.conversationMessage.findUnique({ where: { wamid: e.wamid }, select: { id: true } }))
          return null; // Meta retried the webhook
        const conversation = await this.openConversation(tx, route, e.from, e.profileName);

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

  /**
   * The owner replied from the WhatsApp Business app (a number that stays on the app): the reply
   * shows in the Inbox and the agent steps back from that conversation.
   */
  private async echo(route: WhatsAppRoute, e: EchoMessage): Promise<boolean> {
    try {
      return await this.tenantDb.tx(route.tenantId, async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${route.whatsappNumberId}:${e.to}`}))`;
        if (await tx.conversationMessage.findUnique({ where: { wamid: e.wamid }, select: { id: true } }))
          return false;
        const conversation = await this.openConversation(tx, route, e.to, null);
        await tx.conversationMessage.create({
          data: {
            tenantId: route.tenantId,
            conversationId: conversation.id,
            wamid: e.wamid,
            direction: "OUTBOUND",
            sender: "STAFF",
            type: e.type,
            text: e.text,
            mediaId: e.media?.id ?? null,
            mediaMime: e.media?.mimeType.slice(0, 100) ?? null,
            mediaFilename: e.media?.filename?.slice(0, 255) ?? null,
            replyToWamid: e.replyTo,
            status: "SENT",
            sentAt: e.timestamp,
            meta: { fromBusinessApp: true },
          },
        });
        if (conversation.mode === "AI")
          await note(
            tx,
            route.tenantId,
            conversation.id,
            "Replied from the WhatsApp Business app: the agent stopped answering this conversation",
          );
        await tx.conversation.update({
          where: { id: conversation.id },
          data: {
            mode: "HUMAN",
            lastMessageAt: new Date(),
            lastMessagePreview: previewOf({ type: e.type, text: e.text, mediaFilename: e.media?.filename }),
          },
        });
        return true;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
      throw err;
    }
  }

  /** Meta's news about the WhatsApp Business account: shown on the number's card */
  private async accountNews(e: AccountUpdate | QualityUpdate): Promise<void> {
    const numbers = (await resolveWhatsAppWaba(this.prisma.client, e.wabaId)).filter(
      (n) => !e.number || n.displayNumber.replace(/\D/g, "") === e.number,
    );
    this.metrics.whatsapp.inc({
      event: e.kind,
      result: numbers.length ? e.event.slice(0, 40) : "unknown_account",
    });
    for (const n of numbers) {
      const db = this.tenantDb.db(n.tenantId);
      const current = await db.whatsAppNumber.findUnique({
        where: { id: n.whatsappNumberId },
        select: { lastError: true },
      });
      const data = accountChange(e, current?.lastError ?? null);
      if (data) {
        await db.whatsAppNumber.update({ where: { id: n.whatsappNumberId }, data });
        this.logger.warn({ tenantId: n.tenantId, event: e.event }, "WhatsApp account news from Meta");
      }
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

const FLAGGED = "Meta flagged this number's quality";

/** How account news changes a number (null: nothing to show) */
export function accountChange(
  e: AccountUpdate | QualityUpdate,
  lastError: string | null,
): Prisma.WhatsAppNumberUpdateInput | null {
  const detail = e.kind === "account" && e.detail ? ` (${e.detail.toLowerCase().replace(/_/g, " ")})` : "";
  if (e.kind === "quality") {
    if (e.event === "FLAGGED")
      return {
        lastError: `${FLAGGED}: customers are blocking or reporting its messages. Its messaging limit may drop if this continues.`,
        qualityRating: "RED",
        ...(e.currentLimit ? { messagingLimit: e.currentLimit } : {}),
      };
    if (e.event === "UNFLAGGED")
      return {
        qualityRating: "GREEN",
        ...(lastError?.startsWith(FLAGGED) ? { lastError: null } : {}),
        ...(e.currentLimit ? { messagingLimit: e.currentLimit } : {}),
      };
    return e.currentLimit ? { messagingLimit: e.currentLimit } : null;
  }
  switch (e.event) {
    case "PARTNER_REMOVED":
      return {
        lastError:
          "The business removed this platform's access in Meta, so messages can't be sent or received. Connect the number again.",
      };
    case "ACCOUNT_VIOLATION":
      return {
        lastError: `Meta reported a policy violation on this WhatsApp account${detail}. Check WhatsApp Manager.`,
      };
    case "ACCOUNT_RESTRICTION":
      return {
        lastError: `Meta restricted this WhatsApp account${detail}. Some messages may not be sent. Check WhatsApp Manager.`,
      };
    case "DISABLED_UPDATE":
    case "BAN":
      return { lastError: `Meta disabled this WhatsApp account${detail}. Check WhatsApp Manager.` };
    default:
      return null;
  }
}

async function note(tx: TenantTx, tenantId: string, conversationId: string, text: string) {
  await tx.conversationMessage.create({
    data: {
      tenantId,
      conversationId,
      direction: "INTERNAL",
      sender: "SYSTEM",
      type: "NOTE",
      text,
      status: "RECEIVED",
    },
  });
}
