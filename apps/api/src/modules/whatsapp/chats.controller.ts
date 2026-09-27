import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from "@nestjs/common";
import { ChatListQuery, ChatMessagesQuery, ChatModeBody, ChatReplyBody } from "@platform/shared";
import type { FastifyRequest } from "fastify";
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

  @Post(":id/read")
  @HttpCode(204)
  @RequirePermissions("chats:read")
  async read(@CurrentAuth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    await this.chats.markRead(auth.tenantId, id);
  }
}
