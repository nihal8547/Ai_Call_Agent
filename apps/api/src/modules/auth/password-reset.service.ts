import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { hashPassword, randomToken, sha256Hex } from "@platform/crypto";
import { userMemberships } from "@platform/db";
import { TokenService } from "../../common/auth/token.service";
import { AppException } from "../../common/filters/problem-details.filter";
import { API_ENV, type ApiEnv } from "../../config/env";
import { PrismaService } from "../../infra/prisma.service";
import { RedisService } from "../../infra/redis.service";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AuditService } from "../audit/audit.service";
import { passwordResetEmail } from "../mail/templates";
import { EmailVerificationService } from "./email-verification.service";
import { PlatformMailService } from "../mail/platform-mail.service";

export const RESET_TTL_MINUTES = 30;
const tokenKey = (hash: string) => `pwreset:${hash}`;
const userKey = (userId: string) => `pwreset-user:${userId}`;

/**
 * "Forgot password" by email. The link carries a random token; only its SHA-256 is stored (in
 * Redis, for 30 minutes), it works once, and a newer link replaces an older one. Resetting signs
 * the account out everywhere. Answers never say whether an email has an account.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDbService,
    private readonly redis: RedisService,
    private readonly tokens: TokenService,
    private readonly mail: PlatformMailService,
    private readonly audit: AuditService,
    private readonly verification: EmailVerificationService,
  ) {}

  async request(email: string): Promise<void> {
    const user = await this.prisma.client.user.findUnique({
      where: { email },
      select: { id: true, name: true, email: true },
    });
    if (!user) return;

    const token = randomToken(32);
    const hash = sha256Hex(token);
    const ttl = RESET_TTL_MINUTES * 60;
    const previous = await this.redis.client.get(userKey(user.id));
    const multi = this.redis.client.multi();
    if (previous) multi.del(tokenKey(previous));
    multi.set(tokenKey(hash), user.id, "EX", ttl).set(userKey(user.id), hash, "EX", ttl);
    await multi.exec();

    // In the fragment, so the token never reaches server logs or a Referer header
    const url = `${this.env.WEB_BASE_URL}/reset-password#${token}`;
    const sent = await this.mail.enqueue({
      purpose: "password_reset",
      to: user.email,
      ...passwordResetEmail({ name: user.name, url, minutes: RESET_TTL_MINUTES }),
    });
    if (!sent) {
      if (this.env.NODE_ENV === "development")
        this.logger.warn({ url }, "SMTP_URL is not set: password reset link (development only)");
      else this.logger.warn({ userId: user.id }, "password reset requested but SMTP_URL is not set");
    }
  }

  async reset(
    token: string,
    password: string,
    meta: { ip?: string; userAgent?: string } = {},
  ): Promise<void> {
    const hash = sha256Hex(token);
    // GETDEL: a link works once, even if two requests race
    const userId = await this.redis.client.getdel(tokenKey(hash));
    if (!userId)
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        "TOKEN_EXPIRED",
        "This reset link has expired or was already used. Ask for a new one.",
      );
    await this.redis.client.del(userKey(userId));

    const user = await this.prisma.client.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(password) },
      select: { id: true },
    });
    // The link came by email, so the address is proven too
    await this.verification.markVerified(user.id);
    // Whoever knew the old password is signed out everywhere
    for (const s of await this.tokens.listSessions(user.id)) await this.tokens.revokeFamily(s.id);

    // Memberships are tenant rows: read through the same definer lookup sign-in uses
    for (const m of await userMemberships(this.prisma.client, user.id))
      await this.tenantDb.tx(m.tenantId, (tx) =>
        this.audit.record(
          tx,
          { kind: "system", tenantId: m.tenantId },
          {
            action: "user.password_reset",
            entityType: "user",
            entityId: user.id,
            ...meta,
          },
        ),
      );
  }
}
