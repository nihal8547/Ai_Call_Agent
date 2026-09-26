import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { randomToken, safeEqual } from "@platform/crypto";
import { CrmOAuthStartQuery, IdParam, SaveCrmMappingBody } from "@platform/shared";
import {
  exchangeHubspotCode,
  exchangeZohoCode,
  hubspotAuthUrl,
  ToolError,
  zohoAuthUrl,
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
import { IntegrationsService } from "../integrations/integrations.service";
import { CrmSyncService } from "./crm-sync.service";

const Provider = z.enum(["hubspot", "zoho"]);
const ProviderParam = z.object({ provider: Provider });
const OAuthState = z.object({
  tenantId: z.uuid(),
  userId: z.uuid(),
  provider: Provider,
  name: z.string(),
  binding: z.string(),
});
const CallbackQuery = z.object({
  state: z.string().max(200),
  code: z.string().max(2000).optional(),
  error: z.string().max(200).optional(),
  /** Zoho: the data center the user signed in to */
  "accounts-server": z.string().max(100).optional(),
});
const BINDING_COOKIE = "oauth_binding";
const COOKIE_PATH = "/api/v1/integrations/oauth";
const STATE_TTL_SECONDS = 600;
const RefreshQuery = z.object({ refresh: z.enum(["0", "1"]).default("0") });
const NAMES = { hubspot: "HubSpot", zoho: "Zoho" } as const;

@Controller()
export class CrmController {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly crm: CrmSyncService,
    private readonly integrations: IntegrationsService,
    private readonly redis: RedisService,
    private readonly tenantDb: TenantDbService,
  ) {}

  @RequirePermissions("integrations:read")
  @Get("integrations/:id/crm-mapping")
  mapping(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Query(new ZodValidationPipe(RefreshQuery)) q: z.output<typeof RefreshQuery>,
  ) {
    return this.crm.mappingView(auth.tenantId, id, q.refresh === "1");
  }

  @RequirePermissions("integrations:write")
  @Put("integrations/:id/crm-mapping")
  @RateLimit({ name: "crm-mapping", limit: 20, windowSeconds: 60, by: "ip" })
  saveMapping(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Body(new ZodValidationPipe(SaveCrmMappingBody)) body: SaveCrmMappingBody,
    @Req() req: FastifyRequest,
  ) {
    return this.crm.saveMapping(auth, id, body, requestMeta(req));
  }

  /** Send a lead to the connected CRMs now */
  @RequirePermissions("leads:write")
  @Post("leads/:id/crm-sync")
  @HttpCode(202)
  async syncLead(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
  ) {
    const lead = await this.tenantDb
      .db(auth.tenantId)
      .lead.findUnique({ where: { id }, select: { id: true } });
    if (!lead) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Lead not found");
    await this.crm.enqueueLead(auth.tenantId, id, true);
    return this.tenantDb
      .db(auth.tenantId)
      .lead.findUniqueOrThrow({ where: { id }, select: { id: true, crmSync: true } });
  }

  // ── Connect with HubSpot / Zoho (OAuth) ──────────────────────────────────
  private redirectUri(provider: z.infer<typeof Provider>): string {
    return `${this.env.WEB_BASE_URL}/api/v1/integrations/oauth/${provider}/callback`;
  }

  private client(provider: z.infer<typeof Provider>) {
    return provider === "hubspot" ? this.integrations.hubspotOAuth : this.integrations.zohoOAuth;
  }

  @UserOnly()
  @RequirePermissions("integrations:write")
  @Get("integrations/oauth/:provider/start")
  async start(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(ProviderParam)) { provider }: z.output<typeof ProviderParam>,
    @Query(new ZodValidationPipe(CrmOAuthStartQuery)) q: z.output<typeof CrmOAuthStartQuery>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const client = this.client(provider);
    if (!client)
      throw new AppException(
        HttpStatus.CONFLICT,
        "CONFLICT",
        provider === "hubspot"
          ? "HubSpot sign-in is not configured on this platform. Use a private app token instead."
          : "Zoho sign-in is not configured on this platform. Use a Self Client instead.",
      );
    const state = randomToken(24);
    const binding = randomToken(24);
    const payload: z.infer<typeof OAuthState> = {
      tenantId: auth.tenantId,
      userId: userAuth(auth).userId,
      provider,
      name: q.name,
      binding,
    };
    await this.redis.client.set(`oauth:crm:${state}`, JSON.stringify(payload), "EX", STATE_TTL_SECONDS);
    void reply.setCookie(BINDING_COOKIE, binding, {
      httpOnly: true,
      secure: this.env.COOKIE_SECURE,
      sameSite: "lax",
      path: COOKIE_PATH,
      maxAge: STATE_TTL_SECONDS,
    });
    const args = { clientId: client.clientId, redirectUri: this.redirectUri(provider), state };
    return { url: provider === "hubspot" ? hubspotAuthUrl(args) : zohoAuthUrl(args) };
  }

  /** The CRM sends the browser back here. Authorised by the one-time state and the browser's cookie. */
  @Public()
  @Get("integrations/oauth/:provider/callback")
  @RateLimit({ name: "oauth-callback", limit: 20, windowSeconds: 60, by: "ip" })
  async callback(
    @Param(new ZodValidationPipe(ProviderParam)) { provider }: z.output<typeof ProviderParam>,
    @Query(new ZodValidationPipe(CallbackQuery)) q: z.output<typeof CallbackQuery>,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const raw = await this.redis.client.getdel(`oauth:crm:${q.state}`);
    const state = raw ? OAuthState.safeParse(JSON.parse(raw)) : null;
    const cookie = req.cookies[BINDING_COOKIE];
    void reply.clearCookie(BINDING_COOKIE, { path: COOKIE_PATH });
    if (
      !state?.success ||
      state.data.provider !== provider ||
      !cookie ||
      !safeEqual(cookie, state.data.binding)
    )
      return reply.redirect(`${this.env.WEB_BASE_URL}/login`, 302);
    const s = state.data;
    const tenant = await this.tenantDb
      .db(s.tenantId)
      .tenant.findUniqueOrThrow({ where: { id: s.tenantId }, select: { slug: true } });
    const back = (params: Record<string, string>) =>
      `${this.env.WEB_BASE_URL}/t/${tenant.slug}/integrations?${new URLSearchParams(params)}`;
    const label = NAMES[provider];
    if (q.error || !q.code)
      return reply.redirect(
        back({
          error:
            q.error === "access_denied"
              ? `${label} access was not granted`
              : `${label} sign-in did not complete`,
        }),
        302,
      );
    try {
      const client = this.client(provider);
      const deps = { fetch, timeoutMs: 10_000, ...(client ? { oauthClient: client } : {}) };
      const stored =
        provider === "hubspot"
          ? {
              kind: "oauth",
              refreshToken: await exchangeHubspotCode(q.code, this.redirectUri(provider), deps),
            }
          : {
              kind: "oauth",
              ...(await exchangeZohoCode(
                q.code,
                this.redirectUri(provider),
                q["accounts-server"] ?? "https://accounts.zoho.com",
                deps,
              )),
            };
      const created = await this.integrations.create(
        { kind: "user", userId: s.userId, tenantId: s.tenantId, roleId: "", roleKey: "", permissions: [] },
        {
          type: provider === "hubspot" ? "HUBSPOT" : "ZOHO",
          name: s.name,
          config: {
            syncLeads: true,
            mapping: {},
            ...("accountsServer" in stored ? { dataCenter: stored.accountsServer } : {}),
          },
          stored,
        },
        requestMeta(req),
      );
      return reply.redirect(back({ connected: created.id }), 302);
    } catch (err) {
      const message =
        err instanceof ToolError
          ? err.message
          : err instanceof AppException
            ? String(err.message)
            : `Connecting ${label} failed`;
      return reply.redirect(back({ error: message.slice(0, 200) }), 302);
    }
  }
}
