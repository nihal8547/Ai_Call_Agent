import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req, Res } from "@nestjs/common";
import {
  DisableTotpBody,
  EnableTotpBody,
  ForgotPasswordBody,
  LoginBody,
  LoginMfaBody,
  RegisterBody,
  ResetPasswordBody,
  SwitchTenantBody,
  VerifyEmailBody,
} from "@platform/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { AnyAuthenticated, CurrentAuth, Public, userAuth, UserOnly } from "../../common/auth/decorators";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { requestMeta } from "../../common/http/request-meta";
import { RateLimit } from "../../common/rate-limit/rate-limit";
import { TokenService } from "../../common/auth/token.service";
import { AppException } from "../../common/filters/problem-details.filter";
import { AuditService } from "../audit/audit.service";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AuthService } from "./auth.service";
import { MfaService } from "./mfa.service";
import { EmailVerificationService } from "./email-verification.service";
import { PasswordResetService } from "./password-reset.service";

const FamilyParam = z.object({ id: z.uuid() });

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly tenantDb: TenantDbService,
    private readonly passwordReset: PasswordResetService,
    private readonly verification: EmailVerificationService,
  ) {}

  /** Second step of sign-in, with the ticket the password step returned */
  @Public()
  @Post("login/2fa")
  @HttpCode(200)
  @RateLimit({ name: "login-2fa", limit: 20, windowSeconds: 300, by: "ip" })
  loginMfa(
    @Body(new ZodValidationPipe(LoginMfaBody)) body: z.output<typeof LoginMfaBody>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.auth.loginMfa(body.mfaToken, body.code, req, reply);
  }

  // ── Two-step sign-in set-up ────────────────────────────────────────────────
  @AnyAuthenticated()
  @UserOnly()
  @Post("2fa/setup")
  @HttpCode(200)
  setupTotp(@CurrentAuth() auth: AuthContext) {
    return this.mfa.setup(userAuth(auth).userId);
  }

  @AnyAuthenticated()
  @UserOnly()
  @Post("2fa/enable")
  @HttpCode(200)
  @RateLimit({ name: "2fa-enable", limit: 10, windowSeconds: 300, by: "ip" })
  async enableTotp(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(EnableTotpBody)) body: z.output<typeof EnableTotpBody>,
    @Req() req: FastifyRequest,
  ) {
    const user = userAuth(auth);
    const result = await this.mfa.enable(user.userId, body.code);
    await this.tenantDb.tx(user.tenantId, (tx) =>
      this.audit.record(tx, auth, {
        action: "user.2fa_enabled",
        entityType: "user",
        entityId: user.userId,
        ...requestMeta(req),
      }),
    );
    return result;
  }

  @AnyAuthenticated()
  @UserOnly()
  @Post("2fa/disable")
  @HttpCode(204)
  @RateLimit({ name: "2fa-disable", limit: 10, windowSeconds: 300, by: "ip" })
  async disableTotp(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(DisableTotpBody)) body: z.output<typeof DisableTotpBody>,
    @Req() req: FastifyRequest,
  ): Promise<void> {
    const user = userAuth(auth);
    await this.mfa.disable(user.userId, body.password, body.code);
    await this.tenantDb.tx(user.tenantId, (tx) =>
      this.audit.record(tx, auth, {
        action: "user.2fa_disabled",
        entityType: "user",
        entityId: user.userId,
        ...requestMeta(req),
      }),
    );
  }

  // ── Signed-in devices ─────────────────────────────────────────────────────
  @AnyAuthenticated()
  @UserOnly()
  @Get("sessions")
  async sessions(@CurrentAuth() auth: AuthContext) {
    const user = userAuth(auth);
    const items = await this.tokens.listSessions(user.userId);
    return { items: items.map((s) => ({ ...s, current: s.id === user.familyId })) };
  }

  @AnyAuthenticated()
  @UserOnly()
  @Delete("sessions/:id")
  @HttpCode(204)
  async revokeSession(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(FamilyParam)) { id }: { id: string },
  ): Promise<void> {
    if (!(await this.tokens.revokeSession(userAuth(auth).userId, id)))
      throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Session not found");
  }

  /** Sign out everywhere else (e.g. after losing a phone) */
  @AnyAuthenticated()
  @UserOnly()
  @Post("sessions/revoke-others")
  @HttpCode(200)
  async revokeOthers(@CurrentAuth() auth: AuthContext) {
    const user = userAuth(auth);
    const others = (await this.tokens.listSessions(user.userId)).filter((s) => s.id !== user.familyId);
    for (const s of others) await this.tokens.revokeFamily(s.id);
    return { revoked: others.length };
  }

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

  /**
   * "Forgot password": emails a single-use link when the account exists. The answer is the same
   * either way, so it can't be used to find out who has an account.
   */
  @Public()
  @Post("password/forgot")
  @HttpCode(202)
  @RateLimit(
    { name: "pw-forgot-ip", limit: 5, windowSeconds: 900, by: "ip" },
    { name: "pw-forgot-email", limit: 3, windowSeconds: 3600, by: { bodyField: "email" } },
  )
  async forgotPassword(
    @Body(new ZodValidationPipe(ForgotPasswordBody)) body: z.output<typeof ForgotPasswordBody>,
  ): Promise<{ ok: true }> {
    await this.passwordReset.request(body.email);
    return { ok: true };
  }

  /** Set a new password with the emailed token; signs the account out everywhere */
  @Public()
  @Post("password/reset")
  @HttpCode(204)
  @RateLimit({ name: "pw-reset-ip", limit: 10, windowSeconds: 900, by: "ip" })
  async resetPassword(
    @Body(new ZodValidationPipe(ResetPasswordBody)) body: z.output<typeof ResetPasswordBody>,
    @Req() req: FastifyRequest,
  ): Promise<void> {
    await this.passwordReset.reset(body.token, body.password, requestMeta(req));
  }

  /** Confirm the email address with the token from the link sent at sign-up (works in any browser) */
  @Public()
  @Post("verify-email")
  @HttpCode(204)
  @RateLimit({ name: "verify-email-ip", limit: 20, windowSeconds: 900, by: "ip" })
  async verifyEmail(
    @Body(new ZodValidationPipe(VerifyEmailBody)) body: z.output<typeof VerifyEmailBody>,
    @Req() req: FastifyRequest,
  ): Promise<void> {
    await this.verification.verify(body.token, requestMeta(req));
  }

  /** Send the confirmation link again (a newer link replaces the older one) */
  @AnyAuthenticated()
  @UserOnly()
  @Post("verify-email/resend")
  @HttpCode(202)
  @RateLimit({ name: "verify-email-resend", limit: 10, windowSeconds: 3600, by: "ip" })
  resendVerification(@CurrentAuth() auth: AuthContext) {
    return this.verification.send(userAuth(auth).userId);
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
