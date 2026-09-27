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
  EmailOAuthConfig,
  GoogleCalendarConfig,
  GoogleOAuthStartQuery,
  GoogleSheetsConfig,
  IdParam,
  MicrosoftOAuthStartQuery,
  UpdateIntegrationBody,
} from "@platform/shared";
import {
  exchangeGoogleCodeWithEmail,
  exchangeMicrosoftCode,
  googleAuthUrl,
  microsoftAuthUrl,
  MS_SCOPES,
  SCOPES,
  ToolError,
} from "@platform/tools";
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
  type: z.enum(["GOOGLE_CALENDAR", "GOOGLE_SHEETS", "EMAIL_SMTP"]),
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
/** Microsoft adds error_description; keep what we use */
const MicrosoftCallbackQuery = CallbackQuery.extend({ error_description: z.string().max(2000).optional() });

function oauthErrorMessage(err: unknown, fallback: string): string {
  const message =
    err instanceof ToolError ? err.message : err instanceof AppException ? String(err.message) : fallback;
  return message.slice(0, 200);
}

@Controller()
export class IntegrationsController {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly integrations: IntegrationsService,
    private readonly redis: RedisService,
    private readonly tenantDb: TenantDbService,
  ) {}

  private redirectUri(provider: "google" | "microsoft" = "google"): string {
    // Through the web app's same-origin /api proxy, so the session cookie is on the right site
    return `${this.env.WEB_BASE_URL}/api/v1/integrations/oauth/${provider}/callback`;
  }

  /** Settings typed before the sign-in, validated for the integration type */
  private startConfig(type: "GOOGLE_CALENDAR" | "GOOGLE_SHEETS" | "EMAIL_SMTP", raw: string | undefined) {
    let parsed: unknown = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      throw new AppException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Invalid settings", [
        { path: "config", message: "Invalid JSON" },
      ]);
    }
    const schema =
      type === "GOOGLE_CALENDAR"
        ? GoogleCalendarConfig
        : type === "GOOGLE_SHEETS"
          ? GoogleSheetsConfig
          : EmailOAuthConfig;
    const config = schema.safeParse(parsed);
    if (!config.success)
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        "VALIDATION_FAILED",
        "Invalid settings",
        config.error.issues.map((i) => ({ path: `config.${i.path.join(".")}`, message: i.message })),
      );
    return config.data as Record<string, unknown>;
  }

  /** One-time state in Redis, plus a cookie that binds the flow to this browser */
  private async beginOAuth(
    provider: "google" | "microsoft",
    auth: AuthContext,
    q: { type: z.infer<typeof OAuthState>["type"]; name: string; config: Record<string, unknown> },
    reply: FastifyReply,
  ): Promise<string> {
    const state = randomToken(24);
    const binding = randomToken(24);
    const payload: z.infer<typeof OAuthState> = {
      tenantId: auth.tenantId,
      userId: userAuth(auth).userId,
      type: q.type,
      name: q.name,
      config: q.config,
      binding,
    };
    await this.redis.client.set(
      `oauth:${provider}:${state}`,
      JSON.stringify(payload),
      "EX",
      STATE_TTL_SECONDS,
    );
    // Only this browser can finish the flow: a link crafted by someone else won't carry the cookie
    void reply.setCookie(BINDING_COOKIE, binding, {
      httpOnly: true,
      secure: this.env.COOKIE_SECURE,
      sameSite: "lax",
      path: "/api/v1/integrations/oauth",
      maxAge: STATE_TTL_SECONDS,
    });
    return state;
  }

  /** Read and consume the state; checks the browser binding */
  private async finishOAuth(
    provider: "google" | "microsoft",
    stateParam: string,
    req: FastifyRequest,
    reply: FastifyReply,
  ) {
    const raw = await this.redis.client.getdel(`oauth:${provider}:${stateParam}`);
    const state = raw ? OAuthState.safeParse(JSON.parse(raw)) : null;
    const cookie = req.cookies[BINDING_COOKIE];
    void reply.clearCookie(BINDING_COOKIE, { path: "/api/v1/integrations/oauth" });
    if (!state?.success || !cookie || !safeEqual(cookie, state.data.binding)) return null;
    const s = state.data;
    const tenant = await this.tenantDb
      .db(s.tenantId)
      .tenant.findUniqueOrThrow({ where: { id: s.tenantId }, select: { slug: true } });
    const back = (params: Record<string, string>) =>
      `${this.env.WEB_BASE_URL}/t/${tenant.slug}/integrations?${new URLSearchParams(params)}`;
    const actor = {
      kind: "user" as const,
      userId: s.userId,
      tenantId: s.tenantId,
      roleId: "",
      roleKey: "",
      permissions: [],
    };
    return { s, back, actor };
  }

  @RequirePermissions("integrations:read")
  @Get("integrations")
  async list(@CurrentAuth() auth: AuthContext) {
    return {
      items: await this.integrations.list(auth.tenantId),
      googleOAuth: Boolean(this.integrations.googleOAuth),
      hubspotOAuth: Boolean(this.integrations.hubspotOAuth),
      zohoOAuth: Boolean(this.integrations.zohoOAuth),
      microsoftOAuth: Boolean(this.integrations.microsoftOAuth),
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
    const config = this.startConfig(q.type, q.config);
    const state = await this.beginOAuth("google", auth, { type: q.type, name: q.name, config }, reply);
    return {
      url: googleAuthUrl({
        clientId: client.clientId,
        redirectUri: this.redirectUri("google"),
        scope:
          q.type === "GOOGLE_CALENDAR"
            ? SCOPES.calendar
            : q.type === "GOOGLE_SHEETS"
              ? SCOPES.sheets
              : SCOPES.gmail,
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
    const started = await this.finishOAuth("google", q.state, req, reply);
    if (!started) return reply.redirect(`${this.env.WEB_BASE_URL}/login`, 302);
    const { s, back, actor } = started;
    if (q.error || !q.code)
      return reply.redirect(
        back({
          error:
            q.error === "access_denied" ? "Google access was not granted" : "Google sign-in did not complete",
        }),
        302,
      );
    try {
      const { refreshToken, email } = await exchangeGoogleCodeWithEmail(q.code, this.redirectUri("google"), {
        fetch,
        timeoutMs: 10_000,
        ...(this.integrations.googleOAuth ? { oauthClient: this.integrations.googleOAuth } : {}),
      });
      const created =
        s.type === "EMAIL_SMTP"
          ? await this.createMailbox(actor, s, "google", refreshToken, email, req)
          : await this.integrations.create(
              actor,
              { type: s.type, name: s.name, config: s.config, stored: { kind: "oauth", refreshToken } },
              requestMeta(req),
            );
      return reply.redirect(back({ connected: created.id }), 302);
    } catch (err) {
      return reply.redirect(back({ error: oauthErrorMessage(err, "Connecting Google failed") }), 302);
    }
  }

  // ── Connect with Microsoft (Outlook / Microsoft 365 email) ─────────────────
  @UserOnly()
  @RequirePermissions("integrations:write")
  @Get("integrations/oauth/microsoft/start")
  async microsoftStart(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(MicrosoftOAuthStartQuery)) q: z.output<typeof MicrosoftOAuthStartQuery>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const client = this.integrations.microsoftOAuth;
    if (!client)
      throw new AppException(
        HttpStatus.CONFLICT,
        "CONFLICT",
        "Microsoft sign-in is not configured on this platform. Use your mail server (SMTP) details instead.",
      );
    const config = this.startConfig("EMAIL_SMTP", q.config);
    const state = await this.beginOAuth(
      "microsoft",
      auth,
      { type: "EMAIL_SMTP", name: q.name, config },
      reply,
    );
    return {
      url: microsoftAuthUrl({
        clientId: client.clientId,
        redirectUri: this.redirectUri("microsoft"),
        scope: MS_SCOPES.mail,
        state,
      }),
    };
  }

  /** Microsoft sends the browser back here. Authorised by the one-time state, not by the session. */
  @Public()
  @Get("integrations/oauth/microsoft/callback")
  @RateLimit({ name: "oauth-callback", limit: 20, windowSeconds: 60, by: "ip" })
  async microsoftCallback(
    @Query(new ZodValidationPipe(MicrosoftCallbackQuery)) q: z.output<typeof MicrosoftCallbackQuery>,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const started = await this.finishOAuth("microsoft", q.state, req, reply);
    if (!started) return reply.redirect(`${this.env.WEB_BASE_URL}/login`, 302);
    const { s, back, actor } = started;
    if (q.error || !q.code)
      return reply.redirect(
        back({
          error:
            q.error === "access_denied" || q.error === "consent_required"
              ? "Microsoft access was not granted"
              : "Microsoft sign-in did not complete",
        }),
        302,
      );
    try {
      const { refreshToken, email } = await exchangeMicrosoftCode(
        q.code,
        this.redirectUri("microsoft"),
        MS_SCOPES.mail,
        {
          fetch,
          timeoutMs: 10_000,
          ...(this.integrations.microsoftOAuth ? { oauthClient: this.integrations.microsoftOAuth } : {}),
        },
      );
      const created = await this.createMailbox(actor, s, "microsoft", refreshToken, email, req);
      return reply.redirect(back({ connected: created.id }), 302);
    } catch (err) {
      return reply.redirect(back({ error: oauthErrorMessage(err, "Connecting Microsoft failed") }), 302);
    }
  }

  /** An email integration that sends as the signed-in mailbox */
  private createMailbox(
    actor: Parameters<IntegrationsService["create"]>[0],
    s: z.infer<typeof OAuthState>,
    provider: "google" | "microsoft",
    refreshToken: string,
    email: string | undefined,
    req: FastifyRequest,
  ) {
    const who = provider === "google" ? "Google" : "Microsoft";
    if (!email) throw new ToolError("auth", `${who} didn't share the account's email address`);
    return this.integrations.create(
      actor,
      {
        type: "EMAIL_SMTP",
        name: s.name,
        config: { ...s.config, from: email },
        stored: { kind: `${provider}_oauth`, refreshToken, email },
        publicConfig: { provider, account: email },
      },
      requestMeta(req),
    );
  }
}
