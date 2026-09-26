import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { randomToken, safeEqual } from "@platform/crypto";
import {
  CreateIntegrationBody,
  GoogleCalendarConfig,
  GoogleOAuthStartQuery,
  GoogleSheetsConfig,
  IdParam,
  UpdateIntegrationBody,
} from "@platform/shared";
import { exchangeGoogleCode, googleAuthUrl, SCOPES, ToolError } from "@platform/tools";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, Public, RequirePermissions, UserOnly, userAuth } from "../../common/auth/decorators";
import { AppException } from "../../common/filters/problem-details.filter";
import { requestMeta } from "../../common/http/request-meta";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RateLimit } from "../../common/rate-limit/rate-limit";
import { API_ENV, type ApiEnv } from "../../config/env";
import { RedisService } from "../../infra/redis.service";
import { TenantDbService } from "../../infra/tenant-db.service";
import { IntegrationsService } from "./integrations.service";

const OAuthState = z.object({
  tenantId: z.uuid(),
  userId: z.uuid(),
  type: z.enum(["GOOGLE_CALENDAR", "GOOGLE_SHEETS"]),
  name: z.string(),
  config: z.record(z.string(), z.unknown()),
  /** Also stored in a cookie on the browser that started the flow (login-CSRF protection) */
  binding: z.string(),
});
const BINDING_COOKIE = "oauth_binding";
const CallbackQuery = z.object({
  state: z.string().max(200),
  code: z.string().max(2000).optional(),
  error: z.string().max(200).optional(),
});
const STATE_TTL_SECONDS = 600;

@Controller()
export class IntegrationsController {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly integrations: IntegrationsService,
    private readonly redis: RedisService,
    private readonly tenantDb: TenantDbService,
  ) {}

  private redirectUri(): string {
    // Through the web app's same-origin /api proxy, so the session cookie is on the right site
    return `${this.env.WEB_BASE_URL}/api/v1/integrations/oauth/google/callback`;
  }

  @RequirePermissions("integrations:read")
  @Get("integrations")
  async list(@CurrentAuth() auth: AuthContext) {
    return {
      items: await this.integrations.list(auth.tenantId),
      googleOAuth: Boolean(this.integrations.googleOAuth),
      hubspotOAuth: Boolean(this.integrations.hubspotOAuth),
      zohoOAuth: Boolean(this.integrations.zohoOAuth),
    };
  }

  @RequirePermissions("integrations:write")
  @Post("integrations")
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(CreateIntegrationBody)) body: CreateIntegrationBody,
    @Req() req: FastifyRequest,
  ) {
    return this.integrations.create(auth, body, requestMeta(req));
  }

  @RequirePermissions("integrations:write")
  @Patch("integrations/:id")
  update(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Body(new ZodValidationPipe(UpdateIntegrationBody)) body: z.output<typeof UpdateIntegrationBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.integrations.update(auth, id, body, requestMeta(req));
  }

  @RequirePermissions("integrations:write")
  @Delete("integrations/:id")
  @HttpCode(204)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Req() req: FastifyRequest,
  ): Promise<void> {
    await this.integrations.remove(auth, id, requestMeta(req));
  }

  @RequirePermissions("integrations:write")
  @Post("integrations/:id/test")
  @HttpCode(200)
  @RateLimit({ name: "integration-test", limit: 20, windowSeconds: 60, by: "ip" })
  test(@CurrentAuth() auth: AuthContext, @Param(new ZodValidationPipe(IdParam)) { id }: { id: string }) {
    return this.integrations.test(auth, id);
  }

  // ── Connect with Google (OAuth) ──────────────────────────────────────────
  @UserOnly()
  @RequirePermissions("integrations:write")
  @Get("integrations/oauth/google/start")
  async googleStart(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(GoogleOAuthStartQuery)) q: z.output<typeof GoogleOAuthStartQuery>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const client = this.integrations.googleOAuth;
    if (!client)
      throw new AppException(
        HttpStatus.CONFLICT,
        "CONFLICT",
        "Google sign-in is not configured on this platform. Use a service account key instead.",
      );
    let rawConfig: unknown = {};
    try {
      rawConfig = q.config ? JSON.parse(q.config) : {};
    } catch {
      throw new AppException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Invalid settings", [
        { path: "config", message: "Invalid JSON" },
      ]);
    }
    const schema = q.type === "GOOGLE_CALENDAR" ? GoogleCalendarConfig : GoogleSheetsConfig;
    const config = schema.safeParse(rawConfig);
    if (!config.success)
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        "VALIDATION_FAILED",
        "Invalid settings",
        config.error.issues.map((i) => ({ path: `config.${i.path.join(".")}`, message: i.message })),
      );
    const state = randomToken(24);
    const binding = randomToken(24);
    const payload: z.infer<typeof OAuthState> = {
      tenantId: auth.tenantId,
      userId: userAuth(auth).userId,
      type: q.type,
      name: q.name,
      config: config.data,
      binding,
    };
    await this.redis.client.set(`oauth:google:${state}`, JSON.stringify(payload), "EX", STATE_TTL_SECONDS);
    // Only this browser can finish the flow: a link crafted by someone else won't carry the cookie
    void reply.setCookie(BINDING_COOKIE, binding, {
      httpOnly: true,
      secure: this.env.COOKIE_SECURE,
      sameSite: "lax",
      path: "/api/v1/integrations/oauth",
      maxAge: STATE_TTL_SECONDS,
    });
    return {
      url: googleAuthUrl({
        clientId: client.clientId,
        redirectUri: this.redirectUri(),
        scope: q.type === "GOOGLE_CALENDAR" ? SCOPES.calendar : SCOPES.sheets,
        state,
      }),
    };
  }

  /** Google sends the browser back here. Authorised by the one-time state, not by the session. */
  @Public()
  @Get("integrations/oauth/google/callback")
  @RateLimit({ name: "oauth-callback", limit: 20, windowSeconds: 60, by: "ip" })
  async googleCallback(
    @Query(new ZodValidationPipe(CallbackQuery)) q: z.output<typeof CallbackQuery>,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const raw = await this.redis.client.getdel(`oauth:google:${q.state}`);
    const state = raw ? OAuthState.safeParse(JSON.parse(raw)) : null;
    const cookie = req.cookies[BINDING_COOKIE];
    void reply.clearCookie(BINDING_COOKIE, { path: "/api/v1/integrations/oauth" });
    if (!state?.success || !cookie || !safeEqual(cookie, state.data.binding))
      return reply.redirect(`${this.env.WEB_BASE_URL}/login`, 302);
    const s = state.data;
    const tenant = await this.tenantDb
      .db(s.tenantId)
      .tenant.findUniqueOrThrow({ where: { id: s.tenantId }, select: { slug: true } });
    const back = (params: Record<string, string>) =>
      `${this.env.WEB_BASE_URL}/t/${tenant.slug}/integrations?${new URLSearchParams(params)}`;
    if (q.error || !q.code)
      return reply.redirect(
        back({
          error:
            q.error === "access_denied" ? "Google access was not granted" : "Google sign-in did not complete",
        }),
        302,
      );
    try {
      const refreshToken = await exchangeGoogleCode(q.code, this.redirectUri(), {
        fetch,
        timeoutMs: 10_000,
        ...(this.integrations.googleOAuth ? { oauthClient: this.integrations.googleOAuth } : {}),
      });
      const created = await this.integrations.create(
        { kind: "user", userId: s.userId, tenantId: s.tenantId, roleId: "", roleKey: "", permissions: [] },
        { type: s.type, name: s.name, config: s.config, stored: { kind: "oauth", refreshToken } },
        requestMeta(req),
      );
      return reply.redirect(back({ connected: created.id }), 302);
    } catch (err) {
      const message =
        err instanceof ToolError
          ? err.message
          : err instanceof AppException
            ? String(err.message)
            : "Connecting Google failed";
      return reply.redirect(back({ error: message.slice(0, 200) }), 302);
    }
  }
}
