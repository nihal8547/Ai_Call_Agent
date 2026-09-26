import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { sha256Hex } from "@platform/crypto";
import { resolveApiKey } from "@platform/db";
import { Permission } from "@platform/shared";
import type { FastifyRequest } from "fastify";
import { PrismaService } from "../../infra/prisma.service";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AppException } from "../filters/problem-details.filter";
import { type AuthContext, COOKIE } from "./auth.types";
import { assertCsrf } from "./csrf";
import { IS_PUBLIC } from "./decorators";
import { TokenService } from "./token.service";

const API_KEY_PREFIX = "ApiKey ";

/**
 * Global guard. Resolves the caller from either
 *   - `Authorization: ApiKey vk_…`  (server-to-server, scoped permissions), or
 *   - the `access_token` cookie     (browser session, role permissions, CSRF-checked)
 * and re-checks tenant membership on every request, so removing a member takes effect immediately.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDbService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const authHeader = req.headers.authorization;
    req.auth = authHeader?.startsWith(API_KEY_PREFIX)
      ? await this.fromApiKey(authHeader.slice(API_KEY_PREFIX.length).trim())
      : await this.fromSession(req);
    return true;
  }

  private async fromApiKey(key: string): Promise<AuthContext> {
    const principal = key ? await resolveApiKey(this.prisma.client, sha256Hex(key)) : null;
    if (!principal) throw new AppException(HttpStatus.UNAUTHORIZED, "UNAUTHENTICATED", "Invalid API key");
    // Best-effort usage timestamp; never blocks or fails the request
    void this.tenantDb
      .db(principal.tenantId)
      .apiKey.update({ where: { id: principal.apiKeyId }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
    return {
      kind: "api_key",
      apiKeyId: principal.apiKeyId,
      tenantId: principal.tenantId,
      permissions: principal.scopes.filter((s): s is Permission => Permission.safeParse(s).success),
    };
  }

  private async fromSession(req: FastifyRequest): Promise<AuthContext> {
    const token = req.cookies[COOKIE.access];
    const claims = token ? await this.tokens.verifyAccess(token) : null;
    if (!claims) throw new AppException(HttpStatus.UNAUTHORIZED, "UNAUTHENTICATED", "Sign in required");
    assertCsrf(req);

    const membership = await this.tenantDb.db(claims.tenantId).membership.findUnique({
      where: { tenantId_userId: { tenantId: claims.tenantId, userId: claims.userId } },
      include: { role: true, tenant: { select: { status: true } } },
    });
    if (!membership) throw new AppException(HttpStatus.UNAUTHORIZED, "UNAUTHENTICATED", "Sign in required");
    if (membership.tenant.status !== "ACTIVE") {
      throw new AppException(HttpStatus.FORBIDDEN, "TENANT_SUSPENDED", "This business account is not active");
    }
    return {
      kind: "user",
      userId: claims.userId,
      tenantId: claims.tenantId,
      roleId: membership.roleId,
      roleKey: membership.role.key,
      permissions: membership.role.permissions.filter(
        (p): p is Permission => Permission.safeParse(p).success,
      ),
    };
  }
}
