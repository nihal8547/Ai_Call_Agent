import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import {
  RegisterWhatsAppNumberBody,
  UpdateWhatsAppNumberBody,
  WhatsAppEmbeddedSignupBody,
  WhatsAppManualConnectBody,
  WhatsAppTestMessageBody,
} from "@platform/shared";
import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, RequirePermissions } from "../../common/auth/decorators";
import { requestMeta } from "../../common/http/request-meta";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RateLimit } from "../../common/rate-limit/rate-limit";
import { WhatsAppAccountsService } from "./whatsapp-accounts.service";

/** Settings → WhatsApp: connected numbers and connecting new ones */
@Controller("whatsapp")
export class WhatsAppController {
  constructor(private readonly accounts: WhatsAppAccountsService) {}

  @Get()
  @RequirePermissions("chats:read")
  list(@CurrentAuth() auth: AuthContext) {
    return this.accounts.list(auth.tenantId);
  }

  @Post("connect/embedded-signup")
  @RequirePermissions("chats:manage")
  @RateLimit({ name: "whatsapp-connect", limit: 10, windowSeconds: 600, by: "ip" })
  connectEmbedded(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(WhatsAppEmbeddedSignupBody))
    body: z.output<typeof WhatsAppEmbeddedSignupBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.accounts.connectEmbedded(auth, body, requestMeta(req));
  }

  @Post("connect/manual")
  @RequirePermissions("chats:manage")
  @RateLimit({ name: "whatsapp-connect", limit: 10, windowSeconds: 600, by: "ip" })
  connectManual(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(WhatsAppManualConnectBody)) body: z.output<typeof WhatsAppManualConnectBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.accounts.connectManual(auth, body, requestMeta(req));
  }

  @Patch("numbers/:id")
  @RequirePermissions("chats:manage")
  update(
    @CurrentAuth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateWhatsAppNumberBody)) body: z.output<typeof UpdateWhatsAppNumberBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.accounts.update(auth, id, body, requestMeta(req));
  }

  @Post("numbers/:id/register")
  @RequirePermissions("chats:manage")
  @RateLimit({ name: "whatsapp-register", limit: 10, windowSeconds: 600, by: "ip" })
  register(
    @CurrentAuth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(RegisterWhatsAppNumberBody))
    body: z.output<typeof RegisterWhatsAppNumberBody>,
  ) {
    return this.accounts.retryRegistration(auth, id, body.pin);
  }

  /** Check the connection with Meta: token, registration, webhook subscription, limits */
  @Post("numbers/:id/check")
  @HttpCode(200)
  @RequirePermissions("chats:manage")
  @RateLimit({ name: "whatsapp-check", limit: 20, windowSeconds: 600, by: "ip" })
  check(@CurrentAuth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.accounts.check(auth.tenantId, id);
  }

  @Post("numbers/:id/test")
  @HttpCode(200)
  @RequirePermissions("chats:manage")
  @RateLimit({ name: "whatsapp-test", limit: 10, windowSeconds: 600, by: "ip" })
  test(
    @CurrentAuth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(WhatsAppTestMessageBody)) body: z.output<typeof WhatsAppTestMessageBody>,
  ) {
    return this.accounts.sendTest(auth, id, body.to);
  }

  @Delete("numbers/:id")
  @HttpCode(204)
  @RequirePermissions("chats:manage")
  async disconnect(
    @CurrentAuth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    await this.accounts.disconnect(auth, id, requestMeta(req));
  }
}
