import { HttpStatus, Injectable } from "@nestjs/common";
import type { Prisma, TenantTx } from "@platform/db";
import { type ChatListQuery, type ChatMessagesQuery, WHATSAPP_WINDOW_MS } from "@platform/shared";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { AppException } from "../../common/filters/problem-details.filter";
import { QueueService } from "../../infra/queue.service";
import { StorageService } from "../../infra/storage.service";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AuditService } from "../audit/audit.service";
import { previewOf } from "./whatsapp-inbound.service";

type Meta = { ip?: string; userAgent?: string };

const LIST_VIEW = {
  id: true,
  contactName: true,
  contactPhone: true,
  mode: true,
  lastMessageAt: true,
  lastMessagePreview: true,
  lastInboundAt: true,
  unreadCount: true,
  createdAt: true,
  whatsappNumber: { select: { id: true, displayNumber: true, verifiedName: true, status: true } },
  agent: { select: { id: true, name: true } },
} as const;

const MESSAGE_VIEW = {
  id: true,
  direction: true,
  sender: true,
  type: true,
  text: true,
  mediaMime: true,
  mediaFilename: true,
  mediaSeconds: true,
  mediaKey: true,
  transcriptLanguage: true,
  transcript: true,
  status: true,
  errorCode: true,
  errorTitle: true,
  replyToWamid: true,
  wamid: true,
  meta: true,
  sentAt: true,
  deliveredAt: true,
  readAt: true,
  createdAt: true,
  sentBy: { select: { user: { select: { name: true } } } },
} as const;

/** When free-form replies stop being allowed (null: the customer never wrote) */
export const windowClosesAt = (lastInboundAt: Date | null) =>
  lastInboundAt ? new Date(lastInboundAt.getTime() + WHATSAPP_WINDOW_MS) : null;

const withWindow = <T extends { lastInboundAt: Date | null }>(c: T) => ({
  ...c,
  windowClosesAt: windowClosesAt(c.lastInboundAt),
});

/** The Inbox: conversations, their history, staff replies and who is answering */
@Injectable()
export class ChatsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly queues: QueueService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, q: z.output<typeof ChatListQuery>) {
    const where: Prisma.ConversationWhereInput = {
      ...(q.filter === "open" ? { mode: { not: "CLOSED" } } : {}),
      ...(q.filter === "ai" ? { mode: "AI" } : {}),
      ...(q.filter === "human" ? { mode: "HUMAN" } : {}),
      ...(q.filter === "unread" ? { mode: { not: "CLOSED" }, unreadCount: { gt: 0 } } : {}),
      ...(q.filter === "closed" ? { mode: "CLOSED" } : {}),
      ...(q.before ? { lastMessageAt: { lt: new Date(q.before) } } : {}),
      ...(q.q
        ? {
            OR: [
              { contactName: { contains: q.q, mode: "insensitive" as const } },
              { contactPhone: { contains: q.q.replace(/[^\d+]/g, "") || q.q } },
            ],
          }
        : {}),
    };
    const rows = await this.tenantDb.db(tenantId).conversation.findMany({
      where,
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      select: LIST_VIEW,
    });
    const items = rows.slice(0, q.limit).map(withWindow);
    return {
      items,
      nextBefore: rows.length > q.limit ? items[items.length - 1]!.lastMessageAt.toISOString() : null,
    };
  }

  async unread(tenantId: string) {
    const conversations = await this.tenantDb
      .db(tenantId)
      .conversation.count({ where: { mode: { not: "CLOSED" }, unreadCount: { gt: 0 } } });
    return { conversations };
  }

  async get(tenantId: string, id: string) {
    const c = await this.tenantDb.db(tenantId).conversation.findUnique({
      where: { id },
      select: {
        ...LIST_VIEW,
        whatsappNumber: {
          select: {
            id: true,
            displayNumber: true,
            verifiedName: true,
            status: true,
            agent: { select: { name: true, status: true } },
          },
        },
        contactWaId: true,
        closedAt: true,
        lead: { select: { id: true, customerName: true, status: { select: { label: true } } } },
      },
    });
    if (!c) throw notFound();
    return withWindow(c);
  }

  async messages(tenantId: string, id: string, q: z.output<typeof ChatMessagesQuery>) {
    const db = this.tenantDb.db(tenantId);
    if (!(await db.conversation.count({ where: { id } }))) throw notFound();
    const cursor = q.before
      ? await db.conversationMessage.findFirst({ where: { id: q.before, conversationId: id } })
      : null;
    const rows = await db.conversationMessage.findMany({
      where: {
        conversationId: id,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      select: MESSAGE_VIEW,
    });
    const page = rows.slice(0, q.limit);
    return {
      items: page.reverse().map(({ sentBy, mediaKey, ...m }) => ({
        ...m,
        hasMedia: Boolean(mediaKey),
        sentByName: sentBy?.user.name ?? null,
      })),
      hasMore: rows.length > q.limit,
    };
  }

  /** A staff member writes to the customer; the agent stops answering this conversation */
  async reply(auth: AuthContext, id: string, text: string, meta: Meta) {
    const staff = await this.staff(auth);
    const message = await this.tenantDb.tx(auth.tenantId, async (tx) => {
      const c = await tx.conversation.findUnique({
        where: { id },
        include: { whatsappNumber: { select: { status: true } } },
      });
      if (!c) throw notFound();
      if (c.mode === "CLOSED")
        throw new AppException(
          HttpStatus.CONFLICT,
          "CONFLICT",
          "This conversation is closed. It reopens when the customer writes again.",
        );
      if (c.whatsappNumber.status !== "CONNECTED")
        throw new AppException(
          HttpStatus.CONFLICT,
          "CONFLICT",
          "This WhatsApp number isn't connected. Reconnect it in Settings → WhatsApp.",
        );
      const closes = windowClosesAt(c.lastInboundAt);
      if (!closes || closes <= new Date())
        throw new AppException(
          HttpStatus.CONFLICT,
          "WHATSAPP_WINDOW_CLOSED",
          "More than 24 hours have passed since the customer's last message. WhatsApp only allows approved message templates now.",
        );
      if (c.mode === "AI") await this.note(tx, auth, c.id, `${staff.name} took over from the agent`);
      const m = await tx.conversationMessage.create({
        data: {
          tenantId: auth.tenantId,
          conversationId: c.id,
          direction: "OUTBOUND",
          sender: "STAFF",
          sentById: staff.membershipId,
          type: "TEXT",
          text,
          status: "QUEUED",
          meta: auth.kind === "api_key" ? { apiKeyId: auth.apiKeyId } : {},
        },
        select: MESSAGE_VIEW,
      });
      await tx.conversation.update({
        where: { id: c.id },
        data: {
          mode: "HUMAN",
          lastMessageAt: new Date(),
          lastMessagePreview: previewOf({ type: "TEXT", text }),
          unreadCount: 0,
        },
      });
      await this.audit.record(tx, auth, {
        action: "chat.reply",
        entityType: "conversation",
        entityId: c.id,
        after: { messageId: m.id, length: text.length },
        ...meta,
      });
      return m;
    });
    await this.queues.add(
      "whatsapp",
      {
        kind: "whatsapp_send",
        tenantId: auth.tenantId,
        messageId: message.id,
        label: "Send a WhatsApp reply",
      },
      `wa-send-${message.id}`,
    );
    const { sentBy, mediaKey, ...rest } = message;
    return { ...rest, hasMedia: Boolean(mediaKey), sentByName: sentBy?.user.name ?? staff.name };
  }

  /** Take over (HUMAN), hand back to the agent (AI) or close */
  async setMode(auth: AuthContext, id: string, mode: "AI" | "HUMAN" | "CLOSED", meta: Meta) {
    const staff = await this.staff(auth);
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const c = await tx.conversation.findUnique({ where: { id } });
      if (!c) throw notFound();
      if (c.mode !== mode) {
        const line = {
          HUMAN: `${staff.name} took over from the agent`,
          AI: `${staff.name} handed the conversation back to the agent`,
          CLOSED: `${staff.name} closed the conversation`,
        }[mode];
        await this.note(tx, auth, id, line);
        await tx.conversation.update({
          where: { id },
          data: { mode, closedAt: mode === "CLOSED" ? new Date() : null, lastMessageAt: new Date() },
        });
        await this.audit.record(tx, auth, {
          action: { HUMAN: "chat.take_over", AI: "chat.hand_back", CLOSED: "chat.closed" }[mode],
          entityType: "conversation",
          entityId: id,
          before: { mode: c.mode },
          after: { mode },
          ...meta,
        });
      }
      return withWindow(await tx.conversation.findUniqueOrThrow({ where: { id }, select: LIST_VIEW }));
    });
  }

  /** A stored media file of this conversation; only audio for now (voice notes) */
  async media(tenantId: string, conversationId: string, messageId: string) {
    const m = await this.tenantDb.db(tenantId).conversationMessage.findFirst({
      where: { id: messageId, conversationId },
      select: { mediaKey: true, mediaMime: true, type: true },
    });
    if (!m?.mediaKey || m.type !== "AUDIO")
      throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "No audio for this message");
    const body = await this.storage.storage.get(m.mediaKey);
    // Only audio types are served inline; anything else would be a download
    const mime = /^audio\/[\w.+-]+/.exec(m.mediaMime ?? "")?.[0] ?? "audio/ogg";
    return { body, mime };
  }

  async markRead(tenantId: string, id: string): Promise<void> {
    const r = await this.tenantDb
      .db(tenantId)
      .conversation.updateMany({ where: { id }, data: { unreadCount: 0 } });
    if (!r.count) throw notFound();
  }

  /** A line in the conversation for staff ("Sara took over"); never sent to the customer */
  private async note(tx: TenantTx, auth: AuthContext, conversationId: string, text: string) {
    await tx.conversationMessage.create({
      data: {
        tenantId: auth.tenantId,
        conversationId,
        direction: "INTERNAL",
        sender: "SYSTEM",
        type: "NOTE",
        text,
        status: "RECEIVED",
      },
    });
  }

  private async staff(auth: AuthContext): Promise<{ membershipId: string | null; name: string }> {
    if (auth.kind === "api_key") return { membershipId: null, name: "An API key" };
    const m = await this.tenantDb.db(auth.tenantId).membership.findFirst({
      where: { userId: auth.userId },
      select: { id: true, user: { select: { name: true } } },
    });
    return { membershipId: m?.id ?? null, name: m?.user.name ?? "A team member" };
  }
}

const notFound = () => new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Conversation not found");
