import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { Prisma, TenantTx } from "@platform/db";
import {
  type ChatListQuery,
  type ChatMessagesQuery,
  type ChatTemplateBody,
  WHATSAPP_WINDOW_MS,
} from "@platform/shared";
import type { MessageTemplate } from "@platform/whatsapp";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { AppException } from "../../common/filters/problem-details.filter";
import { API_ENV, type ApiEnv } from "../../config/env";
import { QueueService } from "../../infra/queue.service";
import { RedisService } from "../../infra/redis.service";
import { StorageService } from "../../infra/storage.service";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AuditService } from "../audit/audit.service";
import { metaProblem, WhatsAppAccountsService } from "./whatsapp-accounts.service";
import { previewOf } from "./whatsapp-inbound.service";
import { extensionFor, mediaKey } from "./whatsapp-media.service";

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
  mediaBytes: true,
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
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly tenantDb: TenantDbService,
    private readonly queues: QueueService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly accounts: WhatsAppAccountsService,
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
    return this.send(
      auth,
      id,
      { type: "TEXT", text },
      { action: "chat.reply", after: { length: text.length } },
      meta,
    );
  }

  /** A staff member sends a photo, video or document (with an optional caption) */
  async attach(
    auth: AuthContext,
    id: string,
    file: { buffer: Buffer; filename: string; mime: string },
    caption: string | undefined,
    meta: Meta,
  ) {
    const kind = attachmentKind(file, this.env.WHATSAPP_MEDIA_MAX_MB);
    // Refused before anything is stored (closed, disconnected, window)
    await this.tenantDb.tx(auth.tenantId, (tx) => this.sendable(tx, id, false));
    const messageId = randomUUID();
    const key = mediaKey(auth.tenantId, id, messageId, extensionFor(kind.mime));
    await this.storage.storage.put(key, file.buffer, kind.mime);
    const filename = file.filename.replace(/[\r\n"\\/]/g, "_").slice(0, 200) || "file";
    return this.send(
      auth,
      id,
      {
        id: messageId,
        type: kind.type,
        text: caption || null,
        mediaKey: key,
        mediaMime: kind.mime,
        mediaFilename: filename,
        mediaBytes: file.buffer.length,
      },
      { action: "chat.attachment", after: { type: kind.type, bytes: file.buffer.length } },
      meta,
    );
  }

  /** The number's approved templates (cached for a few minutes: Meta rate-limits this list) */
  async templates(tenantId: string, id: string) {
    const c = await this.tenantDb.db(tenantId).conversation.findUnique({
      where: { id },
      include: { whatsappNumber: true },
    });
    if (!c) throw notFound();
    const number = c.whatsappNumber;
    const cacheKey = `wa-templates:${number.wabaId}`;
    const cached = await this.redis.client.get(cacheKey).catch(() => null);
    let list: MessageTemplate[];
    if (cached) list = JSON.parse(cached) as MessageTemplate[];
    else {
      const creds = await this.accounts.credentials(tenantId, number);
      try {
        list = await this.accounts.graph.messageTemplates(creds.accessToken, number.wabaId);
      } catch (err) {
        throw metaProblem(err, "Loading the templates");
      }
      await this.redis.client.set(cacheKey, JSON.stringify(list), "EX", 300).catch(() => undefined);
    }
    return {
      items: list
        .filter((t) => t.status === "APPROVED")
        .map((t) => ({ ...t, ...templateShape(t) }))
        .sort((a, b) => Number(b.supported) - Number(a.supported) || a.name.localeCompare(b.name)),
    };
  }

  /**
   * Send an approved template: the only message WhatsApp allows more than 24 hours after the
   * customer's last message. Reopens a closed conversation (with staff).
   */
  async sendTemplate(auth: AuthContext, id: string, body: z.output<typeof ChatTemplateBody>, meta: Meta) {
    const { items } = await this.templates(auth.tenantId, id);
    const t = items.find((x) => x.name === body.name && x.language === body.language);
    if (!t)
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        "VALIDATION_FAILED",
        "That template isn't approved for this number",
      );
    if (!t.supported)
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        "VALIDATION_FAILED",
        "Templates with a photo, video or document header, or named values, can't be sent from the Inbox yet",
      );
    if (body.header.length !== t.headerParams || body.body.length !== t.bodyParams)
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        "VALIDATION_FAILED",
        "Fill in every value of the template",
      );
    const fill = (text: string, values: string[]) =>
      text.replace(/\{\{(\d+)\}\}/g, (_, n: string) => values[Number(n) - 1] ?? "");
    const text = [t.headerText ? fill(t.headerText, body.header) : null, fill(t.body, body.body), t.footer]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 4096);
    return this.send(
      auth,
      id,
      {
        type: "TEMPLATE",
        text,
        meta: { template: { name: t.name, language: t.language, header: body.header, body: body.body } },
      },
      { action: "chat.template", after: { template: t.name, language: t.language }, template: true },
      meta,
    );
  }

  /**
   * Store a staff message, take over from the agent and queue it for sending. Templates may go
   * out after the 24-hour window and reopen a closed conversation; everything else may not.
   */
  private async send(
    auth: AuthContext,
    id: string,
    data: {
      id?: string;
      type: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "TEMPLATE";
      text: string | null;
      mediaKey?: string;
      mediaMime?: string;
      mediaFilename?: string;
      mediaBytes?: number;
      meta?: Record<string, unknown>;
    },
    audit: { action: string; after: Record<string, unknown>; template?: boolean },
    meta: Meta,
  ) {
    const staff = await this.staff(auth);
    const message = await this.tenantDb.tx(auth.tenantId, async (tx) => {
      const c = await this.sendable(tx, id, Boolean(audit.template));
      // "Took over" only when an agent was answering (or would answer) this chat
      if (c.mode === "AI" && (c.agentId || c.whatsappNumber.agentId))
        await this.note(tx, auth, c.id, `${staff.name} took over from the agent`);
      if (c.mode === "CLOSED")
        await this.note(tx, auth, c.id, `${staff.name} reopened the conversation with a template`);
      const m = await tx.conversationMessage.create({
        data: {
          ...(data.id ? { id: data.id } : {}),
          tenantId: auth.tenantId,
          conversationId: c.id,
          direction: "OUTBOUND",
          sender: "STAFF",
          sentById: staff.membershipId,
          type: data.type,
          text: data.text,
          mediaKey: data.mediaKey ?? null,
          mediaMime: data.mediaMime ?? null,
          mediaFilename: data.mediaFilename ?? null,
          mediaBytes: data.mediaBytes ?? null,
          status: "QUEUED",
          meta: {
            ...(data.meta ?? {}),
            ...(auth.kind === "api_key" ? { apiKeyId: auth.apiKeyId } : {}),
          } as Prisma.InputJsonObject,
        },
        select: MESSAGE_VIEW,
      });
      await tx.conversation.update({
        where: { id: c.id },
        data: {
          mode: "HUMAN",
          closedAt: null,
          lastMessageAt: new Date(),
          lastMessagePreview: previewOf({
            type: data.type,
            text: data.text,
            mediaFilename: data.mediaFilename,
          }),
          unreadCount: 0,
        },
      });
      await this.audit.record(tx, auth, {
        action: audit.action,
        entityType: "conversation",
        entityId: c.id,
        after: { messageId: m.id, ...audit.after },
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
    const { sentBy, mediaKey: key, ...rest } = message;
    return { ...rest, hasMedia: Boolean(key), sentByName: sentBy?.user.name ?? staff.name };
  }

  /** The conversation, if a message may be sent in it now */
  private async sendable(tx: TenantTx, id: string, template: boolean) {
    const c = await tx.conversation.findUnique({
      where: { id },
      include: { whatsappNumber: { select: { status: true, agentId: true } } },
    });
    if (!c) throw notFound();
    if (c.whatsappNumber.status !== "CONNECTED")
      throw new AppException(
        HttpStatus.CONFLICT,
        "CONFLICT",
        "This WhatsApp number isn't connected. Reconnect it in Settings → WhatsApp.",
      );
    if (template) return c;
    if (c.mode === "CLOSED")
      throw new AppException(
        HttpStatus.CONFLICT,
        "CONFLICT",
        "This conversation is closed. It reopens when the customer writes again, or send a template.",
      );
    const closes = windowClosesAt(c.lastInboundAt);
    if (!closes || closes <= new Date())
      throw new AppException(
        HttpStatus.CONFLICT,
        "WHATSAPP_WINDOW_CLOSED",
        "More than 24 hours have passed since the customer's last message. WhatsApp only allows approved message templates now.",
      );
    return c;
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

  /**
   * A stored file of this conversation. Photos, audio and video play in the Inbox; anything else
   * is a download (never rendered by the browser).
   */
  async media(tenantId: string, conversationId: string, messageId: string) {
    const m = await this.tenantDb.db(tenantId).conversationMessage.findFirst({
      where: { id: messageId, conversationId },
      select: { mediaKey: true, mediaMime: true, mediaFilename: true, type: true },
    });
    if (!m?.mediaKey) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "No file for this message");
    const body = await this.storage.storage.get(m.mediaKey);
    const mime = (m.mediaMime ?? "").split(";")[0]!.trim().toLowerCase();
    const inline = INLINE_TYPES.has(mime) || (m.type === "AUDIO" && /^audio\/[\w.+-]+$/.test(mime));
    const name = m.mediaFilename ?? `${m.type.toLowerCase()}.${extensionFor(mime)}`;
    return {
      body,
      mime: inline ? mime : "application/octet-stream",
      disposition: inline
        ? "inline"
        : `attachment; filename="${name.replace(/[^\w.\- ]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    };
  }

  /** Staff opened the conversation: unread cleared, and the customer sees blue ticks */
  async markRead(tenantId: string, id: string): Promise<void> {
    const db = this.tenantDb.db(tenantId);
    const c = await db.conversation.findUnique({ where: { id }, include: { whatsappNumber: true } });
    if (!c) throw notFound();
    if (!c.unreadCount) return;
    await db.conversation.update({ where: { id }, data: { unreadCount: 0 } });
    if (c.whatsappNumber.status !== "CONNECTED") return;
    // Best effort, after answering: the ticks aren't worth a slow Inbox
    void (async () => {
      const last = await db.conversationMessage.findFirst({
        where: {
          conversationId: id,
          direction: "INBOUND",
          wamid: { not: null },
          createdAt: { gt: new Date(Date.now() - 29 * 86_400_000) },
        },
        orderBy: { createdAt: "desc" },
        select: { wamid: true },
      });
      if (!last?.wamid) return;
      const creds = await this.accounts.credentials(tenantId, c.whatsappNumber);
      await this.accounts.graph.markRead(creds.accessToken, c.whatsappNumber.phoneNumberId, last.wamid);
    })().catch(() => undefined);
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

/** Shown in the Inbox rather than downloaded */
const INLINE_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/3gpp",
]);

/** How many {{n}} values a template text takes; null for named values ({{name}}) */
function placeholders(text: string | null): number | null {
  if (!text) return 0;
  const all = [...text.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]!);
  if (all.some((p) => !/^\d+$/.test(p))) return null;
  return all.length ? Math.max(...all.map(Number)) : 0;
}

/** What the Inbox needs to fill a template in; media headers and named values aren't supported yet */
export function templateShape(t: MessageTemplate) {
  const headerParams = t.headerFormat === "TEXT" ? placeholders(t.headerText) : 0;
  const bodyParams = placeholders(t.body);
  return {
    headerParams: headerParams ?? 0,
    bodyParams: bodyParams ?? 0,
    supported:
      (t.headerFormat === null || t.headerFormat === "TEXT") && headerParams !== null && bodyParams !== null,
  };
}

/**
 * What WhatsApp accepts from staff, by the file's own bytes (not only its name): JPEG/PNG photos
 * up to 5 MB, MP4/3GP video up to 16 MB, PDF and Office documents or plain text up to the limit.
 */
export function attachmentKind(
  file: { buffer: Buffer; filename: string; mime: string },
  maxMb: number,
): { type: "IMAGE" | "VIDEO" | "DOCUMENT"; mime: string } {
  const b = file.buffer;
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(file.filename)?.[1] ?? "").toLowerCase();
  const tooBig = (mb: number) =>
    new AppException(
      HttpStatus.PAYLOAD_TOO_LARGE,
      "PAYLOAD_TOO_LARGE",
      `That file is too large for WhatsApp (up to ${mb} MB)`,
    );
  const starts = (sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);
  let kind: { type: "IMAGE" | "VIDEO" | "DOCUMENT"; mime: string; limitMb: number } | null = null;
  if (starts([0xff, 0xd8, 0xff])) kind = { type: "IMAGE", mime: "image/jpeg", limitMb: 5 };
  else if (starts([0x89, 0x50, 0x4e, 0x47])) kind = { type: "IMAGE", mime: "image/png", limitMb: 5 };
  else if (b.toString("latin1", 4, 8) === "ftyp")
    kind =
      ext === "3gp"
        ? { type: "VIDEO", mime: "video/3gpp", limitMb: 16 }
        : { type: "VIDEO", mime: "video/mp4", limitMb: 16 };
  else if (b.toString("latin1", 0, 5) === "%PDF-")
    kind = { type: "DOCUMENT", mime: "application/pdf", limitMb: maxMb };
  else if (starts([0x50, 0x4b, 0x03, 0x04]) && ["docx", "xlsx", "pptx"].includes(ext))
    kind = {
      type: "DOCUMENT",
      mime: {
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }[ext as "docx" | "xlsx" | "pptx"],
      limitMb: maxMb,
    };
  else if (starts([0xd0, 0xcf, 0x11, 0xe0]) && ["doc", "xls", "ppt"].includes(ext))
    kind = {
      type: "DOCUMENT",
      mime: {
        doc: "application/msword",
        xls: "application/vnd.ms-excel",
        ppt: "application/vnd.ms-powerpoint",
      }[ext as "doc" | "xls" | "ppt"],
      limitMb: maxMb,
    };
  else if (["txt", "csv"].includes(ext) && !b.subarray(0, 4096).includes(0))
    kind = { type: "DOCUMENT", mime: ext === "csv" ? "text/csv" : "text/plain", limitMb: maxMb };
  if (!kind)
    throw new AppException(
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      "UNSUPPORTED_MEDIA_TYPE",
      "WhatsApp takes JPEG or PNG photos, MP4 videos, and PDF, Word, Excel, PowerPoint or text files",
    );
  if (b.length > kind.limitMb * 1024 * 1024) throw tooBig(kind.limitMb);
  return { type: kind.type, mime: kind.mime };
}

const notFound = () => new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Conversation not found");
