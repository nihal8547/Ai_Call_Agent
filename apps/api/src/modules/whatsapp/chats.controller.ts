import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res } from "@nestjs/common";
import { ChatListQuery, ChatMessagesQuery, ChatModeBody, ChatReplyBody } from "@platform/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, RequirePermissions } from "../../common/auth/decorators";
import { requestMeta } from "../../common/http/request-meta";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
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

  /** A conversation's stored voice note (staff play it in the Inbox) */
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
      .header("content-disposition", "inline")
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
