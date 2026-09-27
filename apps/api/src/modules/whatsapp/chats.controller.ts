import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import {
  ChatAttachmentFields,
  ChatListQuery,
  ChatMessagesQuery,
  ChatModeBody,
  ChatReplyBody,
  ChatTemplateBody,
} from "@platform/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, RequirePermissions } from "../../common/auth/decorators";
import { requestMeta } from "../../common/http/request-meta";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AppException } from "../../common/filters/problem-details.filter";
import { RateLimit } from "../../common/rate-limit/rate-limit";
import { ChatsService } from "./chats.service";

/** The Inbox: WhatsApp conversations */
@Controller("chats")
export class ChatsController {
  constructor(private readonly chats: ChatsService) {}

  @Get()
  @RequirePermissions("chats:read")
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(ChatListQuery)) q: z.output<typeof ChatListQuery>,
  ) {
    return this.chats.list(auth.tenantId, q);
  }

  @Get("unread")
  @RequirePermissions("chats:read")
  unread(@CurrentAuth() auth: AuthContext) {
    return this.chats.unread(auth.tenantId);
  }

  @Get(":id")
  @RequirePermissions("chats:read")
  get(@CurrentAuth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.chats.get(auth.tenantId, id);
  }

  @Get(":id/messages")
  @RequirePermissions("chats:read")
  messages(
    @CurrentAuth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(ChatMessagesQuery)) q: z.output<typeof ChatMessagesQuery>,
  ) {
    return this.chats.messages(auth.tenantId, id, q);
  }

  @Post(":id/messages")
  @RequirePermissions("chats:reply")
  @RateLimit({ name: "chat-reply", limit: 60, windowSeconds: 60, by: "ip" })
  reply(
    @CurrentAuth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(ChatReplyBody)) body: z.output<typeof ChatReplyBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.chats.reply(auth, id, body.text, requestMeta(req));
  }

  /** multipart/form-data: caption (optional, before the file) + file */
  @Post(":id/attachments")
  @RequirePermissions("chats:reply")
  @RateLimit({ name: "chat-attachment", limit: 20, windowSeconds: 60, by: "ip" })
  async attach(
    @CurrentAuth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart())
      throw new AppException(
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        "UNSUPPORTED_MEDIA_TYPE",
        "Send the file as multipart/form-data",
      );
    const file = await req.file();
    if (!file)
      throw new AppException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Choose a file", [
        { path: "file", message: "Choose a file" },
      ]);
    const buffer = await file.toBuffer(); // the upload size limit applies (413)
    const captionField = file.fields.caption as { value?: unknown } | undefined;
    const fields = ChatAttachmentFields.safeParse({
      caption:
        typeof captionField?.value === "string" && captionField.value.trim() ? captionField.value : undefined,
    });
    if (!fields.success)
      throw new AppException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "The caption is too long", [
        { path: "caption", message: "Up to 1,024 characters" },
      ]);
    if (!buffer.length)
      throw new AppException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "The file is empty", [
        { path: "file", message: "The file is empty" },
      ]);
    return this.chats.attach(
      auth,
      id,
      { buffer, filename: file.filename || "file", mime: file.mimetype },
      fields.data.caption,
      requestMeta(req),
    );
  }

  /** The number's approved message templates (for replies after 24 hours) */
  @Get(":id/templates")
  @RequirePermissions("chats:reply")
  templates(@CurrentAuth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.chats.templates(auth.tenantId, id);
  }

  @Post(":id/template")
  @RequirePermissions("chats:reply")
  @RateLimit({ name: "chat-template", limit: 30, windowSeconds: 60, by: "ip" })
  sendTemplate(
    @CurrentAuth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(ChatTemplateBody)) body: z.output<typeof ChatTemplateBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.chats.sendTemplate(auth, id, body, requestMeta(req));
  }

  @Post(":id/mode")
  @HttpCode(200)
  @RequirePermissions("chats:reply")
  mode(
    @CurrentAuth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(ChatModeBody)) body: z.output<typeof ChatModeBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.chats.setMode(auth, id, body.mode, requestMeta(req));
  }

  /** A conversation's stored file: photos, voice notes and videos play in the Inbox; others download */
  @Get(":id/messages/:messageId/media")
  @RequirePermissions("chats:read")
  async media(
    @CurrentAuth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("messageId", ParseUUIDPipe) messageId: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const file = await this.chats.media(auth.tenantId, id, messageId);
    const size = file.body.length;
    void reply
      .header("content-type", file.mime)
      .header("content-disposition", file.disposition)
      .header("cache-control", "private, max-age=300")
      .header("x-content-type-options", "nosniff")
      .header("accept-ranges", "bytes");
    // Browsers read an Ogg file's length from its last page, so the player asks for byte ranges
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        void reply.code(416).header("content-range", `bytes */${size}`).send();
        return;
      }
      void reply
        .code(206)
        .header("content-range", `bytes ${start}-${end}/${size}`)
        .send(file.body.subarray(start, end + 1));
      return;
    }
    void reply.send(file.body);
  }

  @Post(":id/read")
  @HttpCode(204)
  @RequirePermissions("chats:read")
  async read(@CurrentAuth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    await this.chats.markRead(auth.tenantId, id);
  }
}
