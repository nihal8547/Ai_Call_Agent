import { Body, Controller, Get, HttpCode, Post, Req, Res } from "@nestjs/common";
import { LoginBody, RegisterBody, SwitchTenantBody } from "@platform/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { type z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { AnyAuthenticated, CurrentAuth, Public, userAuth, UserOnly } from "../../common/auth/decorators";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RateLimit } from "../../common/rate-limit/rate-limit";
import { AuthService } from "./auth.service";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post("register")
  @RateLimit({ name: "register", limit: 5, windowSeconds: 3600, by: "ip" })
  register(
    @Body(new ZodValidationPipe(RegisterBody)) body: z.output<typeof RegisterBody>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.auth.register(body, req, reply);
  }

  @Public()
  @Post("login")
  @HttpCode(200)
  @RateLimit(
    { name: "login-ip", limit: 20, windowSeconds: 60, by: "ip" },
    { name: "login-email", limit: 10, windowSeconds: 3600, by: { bodyField: "email" } },
  )
  login(
    @Body(new ZodValidationPipe(LoginBody)) body: z.output<typeof LoginBody>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.auth.login(body, req, reply);
  }

  /** Public because the access token may already be expired; authenticated by the refresh cookie + CSRF */
  @Public()
  @Post("refresh")
  @HttpCode(200)
  @RateLimit({ name: "refresh", limit: 60, windowSeconds: 60, by: "ip" })
  refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.auth.refresh(req, reply);
  }

  @Public()
  @Post("logout")
  @HttpCode(204)
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.auth.logout(req, reply);
  }

  @AnyAuthenticated()
  @UserOnly()
  @Get("me")
  me(@CurrentAuth() auth: AuthContext) {
    const user = userAuth(auth);
    return this.auth.me(user.userId, user.tenantId);
  }

  @AnyAuthenticated()
  @UserOnly()
  @Post("switch-tenant")
  @HttpCode(200)
  switchTenant(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(SwitchTenantBody)) body: z.output<typeof SwitchTenantBody>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.auth.switchTenant(auth, body.tenantId, req, reply);
  }
}
