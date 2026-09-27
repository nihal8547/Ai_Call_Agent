import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { hashPassword, parseMasterKey, verifyDummyPassword, verifyPassword } from "@platform/crypto";
import {
  Prisma,
  provisionTenant,
  userMemberships,
  type UserMembership,
  userSuspendedBusiness,
} from "@platform/db";
import { type LoginBody, type MeResponse, type RegisterBody } from "@platform/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { type z } from "zod";
import { type AuthContext, COOKIE } from "../../common/auth/auth.types";
import { assertCsrf } from "../../common/auth/csrf";
import { TokenService } from "../../common/auth/token.service";
import { AppException } from "../../common/filters/problem-details.filter";
import { requestMeta } from "../../common/http/request-meta";
import { API_ENV, type ApiEnv } from "../../config/env";
import { PrismaService } from "../../infra/prisma.service";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AuditService } from "../audit/audit.service";
import { EmailVerificationService } from "./email-verification.service";
import { MfaService } from "./mfa.service";

type RegisterInput = z.output<typeof RegisterBody>;
type LoginInput = z.output<typeof LoginBody>;

const invalidCredentials = () =>
  new AppException(HttpStatus.UNAUTHORIZED, "INVALID_CREDENTIALS", "Email or password is incorrect");

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug.length >= 3 ? slug : `biz-${slug || randomBytes(3).toString("hex")}`;
}

@Injectable()
export class AuthService {
  private readonly masterKey: Buffer;

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDbService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly mfa: MfaService,
    private readonly verification: EmailVerificationService,
  ) {
    this.masterKey = parseMasterKey(env.MASTER_ENCRYPTION_KEY);
  }

  async register(body: RegisterInput, req: FastifyRequest, reply: FastifyReply): Promise<MeResponse> {
    const existing = await this.prisma.client.user.findUnique({ where: { email: body.email } });
    if (existing) {
      throw new AppException(HttpStatus.CONFLICT, "CONFLICT", "An account with this email already exists", [
        { path: "email", message: "An account with this email already exists" },
      ]);
    }

    const user = await this.prisma.client.user.create({
      data: {
        email: body.email,
        name: body.name,
        passwordHash: await hashPassword(body.password),
        termsAcceptedAt: new Date(),
        termsVersion: this.env.TERMS_VERSION,
      },
    });

    let tenant: Awaited<ReturnType<AuthService["provisionWithUniqueSlug"]>>;
    try {
      tenant = await this.provisionWithUniqueSlug(body, user.id);
      const created = tenant;
      await this.tenantDb.tx(created.id, (tx) =>
        this.audit.record(
          tx,
          { kind: "system", tenantId: created.id },
          {
            action: "tenant.created",
            entityType: "tenant",
            entityId: created.id,
            after: { name: created.name, slug: created.slug },
            ...requestMeta(req),
          },
        ),
      );
      await this.tokens.issueSession(reply, req, { userId: user.id, tenantId: tenant.id });
    } catch (err) {
      // Keep registration atomic from the user's point of view
      await this.prisma.client.user.delete({ where: { id: user.id } }).catch(() => undefined);
      throw err;
    }
    // The account exists either way; a mail hiccup is fixed with "send again"
    if (this.env.EMAIL_VERIFICATION === "required")
      await this.verification.send(user.id).catch(() => undefined);
    return this.me(user.id, tenant.id);
  }

  private async provisionWithUniqueSlug(body: RegisterInput, ownerUserId: string) {
    const base = body.slug ?? slugify(body.businessName);
    for (let attempt = 0; attempt < 4; attempt++) {
      const slug = attempt === 0 ? base : `${base.slice(0, 33)}-${randomBytes(3).toString("hex")}`;
      try {
        return await provisionTenant(this.prisma.client, this.masterKey, {
          name: body.businessName,
          slug,
          industry: body.industry,
          country: body.country,
          ...(body.timezone ? { timezone: body.timezone } : {}),
          ownerUserId,
        });
      } catch (err) {
        const slugTaken = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
        if (!slugTaken) throw err;
        if (body.slug) {
          throw new AppException(HttpStatus.CONFLICT, "CONFLICT", "This business URL is already taken", [
            { path: "slug", message: "This business URL is already taken" },
          ]);
        }
      }
    }
    throw new AppException(
      HttpStatus.CONFLICT,
      "CONFLICT",
      "Could not allocate a business URL, please choose one",
    );
  }

  async login(body: LoginInput, req: FastifyRequest, reply: FastifyReply) {
    const user = await this.prisma.client.user.findUnique({ where: { email: body.email } });
    if (!user) {
      await verifyDummyPassword(body.password);
      throw invalidCredentials();
    }
    if (!(await verifyPassword(user.passwordHash, body.password))) throw invalidCredentials();

    const memberships = await userMemberships(this.prisma.client, user.id);
    const target = body.tenantSlug
      ? memberships.find((m) => m.tenantSlug === body.tenantSlug)
      : memberships[0];
    if (!target) {
      const suspended = await userSuspendedBusiness(this.prisma.client, user.id);
      if (suspended)
        throw new AppException(
          HttpStatus.FORBIDDEN,
          "TENANT_SUSPENDED",
          `${suspended}'s account is suspended. Contact the platform's support to reactivate it.`,
        );
      throw new AppException(HttpStatus.FORBIDDEN, "FORBIDDEN", "You are not a member of an active business");
    }
    // Two-step sign-in: the password alone opens nothing
    if (user.totpEnabledAt)
      return { mfaRequired: true as const, mfaToken: await this.mfa.issueTicket(user.id, target.tenantId) };
    return this.signIn(user.id, target.tenantId, req, reply);
  }

  /** Second step of sign-in: an authenticator or recovery code */
  async loginMfa(mfaToken: string, code: string, req: FastifyRequest, reply: FastifyReply) {
    const { userId, tenantId } = await this.mfa.redeemTicket(mfaToken, code);
    return this.signIn(userId, tenantId, req, reply);
  }

  private async signIn(userId: string, tenantId: string, req: FastifyRequest, reply: FastifyReply) {
    await this.prisma.client.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    await this.tokens.issueSession(reply, req, { userId, tenantId });
    return this.me(userId, tenantId);
  }

  async refresh(req: FastifyRequest, reply: FastifyReply): Promise<{ ok: true }> {
    const token = req.cookies[COOKIE.refresh];
    if (!token) throw new AppException(HttpStatus.UNAUTHORIZED, "UNAUTHENTICATED", "Sign in required");
    assertCsrf(req);
    const session = await this.tokens.rotate(token);

    const memberships = await userMemberships(this.prisma.client, session.userId);
    const target = memberships.find((m) => m.tenantId === session.tenantId) ?? memberships[0];
    if (!target) {
      this.tokens.clearCookies(reply);
      throw new AppException(HttpStatus.UNAUTHORIZED, "UNAUTHENTICATED", "Sign in required");
    }
    await this.tokens.issueSession(
      reply,
      req,
      { userId: session.userId, tenantId: target.tenantId },
      session.familyId,
    );
    return { ok: true };
  }

  async logout(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    assertCsrf(req);
    const token = req.cookies[COOKIE.refresh];
    if (token) await this.tokens.revokeByToken(token);
    this.tokens.clearCookies(reply);
  }

  async switchTenant(
    auth: AuthContext,
    tenantId: string,
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<MeResponse> {
    if (auth.kind !== "user") throw new AppException(HttpStatus.FORBIDDEN, "FORBIDDEN");
    const memberships = await userMemberships(this.prisma.client, auth.userId);
    if (!memberships.some((m) => m.tenantId === tenantId)) {
      throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Business not found");
    }
    const token = req.cookies[COOKIE.refresh];
    if (token) await this.tokens.revokeByToken(token);
    await this.tokens.issueSession(reply, req, { userId: auth.userId, tenantId });
    return this.me(auth.userId, tenantId);
  }

  async me(userId: string, tenantId: string): Promise<MeResponse> {
    const [user, memberships, membership] = await Promise.all([
      this.prisma.client.user.findUniqueOrThrow({ where: { id: userId } }),
      userMemberships(this.prisma.client, userId),
      this.tenantDb.db(tenantId).membership.findUniqueOrThrow({
        where: { tenantId_userId: { tenantId, userId } },
        include: { role: true, tenant: true },
      }),
    ]);
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isPlatformOwner: user.isPlatformOwner,
        totpEnabled: Boolean(user.totpEnabledAt),
        emailVerified: this.env.EMAIL_VERIFICATION === "off" || Boolean(user.emailVerifiedAt),
      },
      tenant: {
        id: membership.tenant.id,
        name: membership.tenant.name,
        slug: membership.tenant.slug,
        timezone: membership.tenant.timezone,
        country: membership.tenant.country,
        callingCode: membership.tenant.callingCode,
        currency: membership.tenant.currency,
      },
      role: { id: membership.role.id, key: membership.role.key, name: membership.role.name },
      permissions: membership.role.permissions,
      memberships: memberships.map((m: UserMembership) => ({
        tenantId: m.tenantId,
        tenantName: m.tenantName,
        tenantSlug: m.tenantSlug,
        roleKey: m.roleKey,
      })),
    };
  }
}
