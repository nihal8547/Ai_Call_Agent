import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  normaliseRecoveryCode,
  openJson,
  parseMasterKey,
  randomToken,
  sealJson,
  sha256Hex,
  totpUri,
  verifyPassword,
  verifyTotp,
} from "@platform/crypto";
import { AppException } from "../../common/filters/problem-details.filter";
import { API_ENV, type ApiEnv } from "../../config/env";
import { PrismaService } from "../../infra/prisma.service";
import { RedisService } from "../../infra/redis.service";

const TICKET_TTL_SECONDS = 300;
const SETUP_TTL_SECONDS = 600;
const MAX_ATTEMPTS = 5;
const ISSUER = "Voice Agent Platform";

const badCode = () =>
  new AppException(HttpStatus.UNAUTHORIZED, "INVALID_CREDENTIALS", "That code is not right");

/**
 * Two-step sign-in with an authenticator app (TOTP). The secret is encrypted with the platform
 * master key (users belong to many businesses, so no tenant key fits); recovery codes are stored
 * only as hashes and work once each. A code can't be used twice (replay).
 */
@Injectable()
export class MfaService {
  private readonly masterKey: Buffer;

  constructor(
    @Inject(API_ENV) env: ApiEnv,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    this.masterKey = parseMasterKey(env.MASTER_ENCRYPTION_KEY);
  }

  /** Password was right; the second step is still owed. Returns a short-lived ticket. */
  async issueTicket(userId: string, tenantId: string): Promise<string> {
    const token = randomToken(24);
    await this.redis.client.set(
      `mfa:${sha256Hex(token)}`,
      JSON.stringify({ userId, tenantId }),
      "EX",
      TICKET_TTL_SECONDS,
    );
    return token;
  }

  /** Check the second step; returns who signed in. Five wrong codes burn the ticket. */
  async redeemTicket(token: string, code: string): Promise<{ userId: string; tenantId: string }> {
    const key = `mfa:${sha256Hex(token)}`;
    const raw = await this.redis.client.get(key);
    if (!raw)
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        "TOKEN_EXPIRED",
        "The sign-in took too long, please start again",
      );
    const ticket = JSON.parse(raw) as { userId: string; tenantId: string };
    const attempts = await this.redis.client.incr(`${key}:attempts`);
    await this.redis.client.expire(`${key}:attempts`, TICKET_TTL_SECONDS);
    if (attempts > MAX_ATTEMPTS) {
      await this.redis.client.del(key);
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        "UNAUTHENTICATED",
        "Too many wrong codes, please sign in again",
      );
    }
    if (!(await this.check(ticket.userId, code))) throw badCode();
    await this.redis.client.del(key, `${key}:attempts`);
    return ticket;
  }

  /** An authenticator code (not used before) or an unused recovery code */
  async check(userId: string, code: string): Promise<boolean> {
    const user = await this.prisma.client.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totpSecretEnc || !user.totpEnabledAt) return false;
    const { secret } = openJson<{ secret: string }>(
      this.masterKey,
      Buffer.from(user.totpSecretEnc),
      aad(userId),
    );
    const step = verifyTotp(secret, code);
    if (step !== null) {
      // Each code works once, even inside its 90-second window
      const fresh = await this.redis.client.set(`totp-used:${userId}:${step}`, "1", "EX", 120, "NX");
      return fresh === "OK";
    }
    const hash = sha256Hex(normaliseRecoveryCode(code));
    if (!user.totpRecoveryHashes.includes(hash)) return false;
    // Conditional: two sign-ins racing with one recovery code can't both succeed
    const { count } = await this.prisma.client.user.updateMany({
      where: { id: userId, totpRecoveryHashes: { has: hash } },
      data: { totpRecoveryHashes: user.totpRecoveryHashes.filter((h) => h !== hash) },
    });
    return count === 1;
  }

  async enabled(userId: string): Promise<boolean> {
    const u = await this.prisma.client.user.findUniqueOrThrow({
      where: { id: userId },
      select: { totpEnabledAt: true },
    });
    return Boolean(u.totpEnabledAt);
  }

  /** Start: a new secret for the app (not active until a code from it is confirmed) */
  async setup(userId: string) {
    if (await this.enabled(userId))
      throw new AppException(HttpStatus.CONFLICT, "CONFLICT", "Two-step sign-in is already on");
    const user = await this.prisma.client.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    });
    const secret = generateTotpSecret();
    await this.redis.client.set(`totp-setup:${userId}`, secret, "EX", SETUP_TTL_SECONDS);
    return { secret, otpauthUrl: totpUri({ issuer: ISSUER, account: user.email, secret }) };
  }

  /** Confirm with a code from the app; returns recovery codes, shown this once */
  async enable(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const secret = await this.redis.client.get(`totp-setup:${userId}`);
    if (!secret) throw new AppException(HttpStatus.CONFLICT, "CONFLICT", "Start the set-up again");
    if (verifyTotp(secret, code) === null) throw badCode();
    const recoveryCodes = generateRecoveryCodes();
    await this.prisma.client.user.update({
      where: { id: userId },
      data: {
        totpSecretEnc: new Uint8Array(sealJson(this.masterKey, { secret }, aad(userId))),
        totpEnabledAt: new Date(),
        totpRecoveryHashes: recoveryCodes.map((c) => sha256Hex(normaliseRecoveryCode(c))),
      },
    });
    await this.redis.client.del(`totp-setup:${userId}`);
    return { recoveryCodes };
  }

  async disable(userId: string, password: string, code: string): Promise<void> {
    const user = await this.prisma.client.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(user.passwordHash, password)))
      throw new AppException(HttpStatus.UNAUTHORIZED, "INVALID_CREDENTIALS", "Password is incorrect");
    if (!(await this.check(userId, code))) throw badCode();
    await this.prisma.client.user.update({
      where: { id: userId },
      data: { totpSecretEnc: null, totpEnabledAt: null, totpRecoveryHashes: [] },
    });
  }
}

const aad = (userId: string) => `user:${userId}:totp`;
