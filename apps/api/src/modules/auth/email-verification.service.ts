import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { randomToken, sha256Hex } from "@platform/crypto";
import { userMemberships } from "@platform/db";
import { AppException } from "../../common/filters/problem-details.filter";
import { API_ENV, type ApiEnv } from "../../config/env";
import { PrismaService } from "../../infra/prisma.service";
import { RedisService } from "../../infra/redis.service";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AuditService } from "../audit/audit.service";
import { PlatformMailService } from "../mail/platform-mail.service";
import { emailVerificationEmail } from "../mail/templates";

export const VERIFY_TTL_HOURS = 24;
const tokenKey = (hash: string) => `emailverify:${hash}`;
const userKey = (userId: string) => `emailverify-user:${userId}`;

export type VerificationSent = {
  sent: boolean;
  alreadyVerified?: true;
  /** Development without a mail server: the link, to open by hand */
  devUrl?: string;
};

/**
 * "Confirm your email" after sign-up, the same way as password resets: a random token in the
 * link, only its SHA-256 in Redis (24 hours), single use, a newer link replaces an older one.
 * Accepting an emailed invitation or resetting a password also proves the address.
 */
@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDbService,
    private readonly redis: RedisService,
    private readonly mail: PlatformMailService,
    private readonly audit: AuditService,
  ) {}

  async send(userId: string): Promise<VerificationSent> {
    const user = await this.prisma.client.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, name: true, email: true, emailVerifiedAt: true },
    });
    if (user.emailVerifiedAt) return { sent: false, alreadyVerified: true };

    const token = randomToken(32);
    const hash = sha256Hex(token);
    const ttl = VERIFY_TTL_HOURS * 3600;
    const previous = await this.redis.client.get(userKey(user.id));
    const multi = this.redis.client.multi();
    if (previous) multi.del(tokenKey(previous));
    multi.set(tokenKey(hash), user.id, "EX", ttl).set(userKey(user.id), hash, "EX", ttl);
    await multi.exec();

    // In the fragment, so the token never reaches server logs or a Referer header
    const url = `${this.env.WEB_BASE_URL}/verify-email#${token}`;
    const sent = await this.mail.enqueue({
      purpose: "email_verification",
      to: user.email,
      ...emailVerificationEmail({ name: user.name, url, hours: VERIFY_TTL_HOURS }),
    });
    if (sent) return { sent };
    if (this.env.NODE_ENV === "development") {
      this.logger.warn({ url }, "SMTP_URL is not set: email confirmation link (development only)");
      return { sent, devUrl: url };
    }
    this.logger.warn({ userId: user.id }, "email confirmation needed but SMTP_URL is not set");
    return { sent };
  }

  /** Opens the emailed link (any browser: the token is the proof) */
  async verify(token: string, meta: { ip?: string; userAgent?: string } = {}): Promise<void> {
    const userId = await this.redis.client.getdel(tokenKey(sha256Hex(token)));
    if (!userId)
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        "TOKEN_EXPIRED",
        "This link has expired or was already used. Sign in and send a new one.",
      );
    await this.redis.client.del(userKey(userId));
    if (!(await this.markVerified(userId))) return;
    for (const m of await userMemberships(this.prisma.client, userId))
      await this.tenantDb.tx(m.tenantId, (tx) =>
        this.audit.record(
          tx,
          { kind: "system", tenantId: m.tenantId },
          { action: "user.email_verified", entityType: "user", entityId: userId, ...meta },
        ),
      );
  }

  /** The address is proven another way (invitation or reset link). True if it wasn't before. */
  async markVerified(userId: string): Promise<boolean> {
    const { count } = await this.prisma.client.user.updateMany({
      where: { id: userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
    if (count) await this.redis.client.del(userKey(userId));
    return count > 0;
  }
}
