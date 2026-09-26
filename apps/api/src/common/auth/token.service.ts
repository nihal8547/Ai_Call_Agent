import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { randomToken, sha256Hex } from "@platform/crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { jwtVerify, SignJWT } from "jose";
import { randomUUID } from "node:crypto";
import { API_ENV, type ApiEnv } from "../../config/env";
import { PrismaService } from "../../infra/prisma.service";
import { AppException } from "../filters/problem-details.filter";
import { COOKIE } from "./auth.types";

export type AccessClaims = { userId: string; tenantId: string };

const REFRESH_PATH = "/api/v1/auth";

/**
 * Sessions = short-lived access JWT (httpOnly cookie) + rotating refresh token (httpOnly cookie,
 * only sent to /api/v1/auth) + CSRF token (readable cookie).
 *
 * Refresh tokens rotate on every use. Presenting an already-used token means it was stolen,
 * so the whole token family (every session descended from that login) is revoked.
 */
@Injectable()
export class TokenService {
  private readonly key: Uint8Array;

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
  ) {
    this.key = new TextEncoder().encode(env.JWT_SECRET);
  }

  async issueSession(
    reply: FastifyReply,
    req: FastifyRequest,
    claims: AccessClaims,
    familyId: string = randomUUID(),
  ): Promise<void> {
    const refresh = randomToken(32);
    await this.prisma.client.refreshToken.create({
      data: {
        userId: claims.userId,
        activeTenantId: claims.tenantId,
        tokenHash: sha256Hex(refresh),
        familyId,
        expiresAt: new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
        userAgent: req.headers["user-agent"]?.slice(0, 500) ?? null,
        ip: req.ip,
      },
    });
    const access = await new SignJWT({ tid: claims.tenantId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(claims.userId)
      .setIssuedAt()
      .setExpirationTime(`${this.env.ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.key);

    const base = { httpOnly: true, secure: this.env.COOKIE_SECURE, sameSite: "lax" as const };
    void reply.setCookie(COOKIE.access, access, {
      ...base,
      path: "/",
      maxAge: this.env.ACCESS_TOKEN_TTL_SECONDS,
    });
    void reply.setCookie(COOKIE.refresh, refresh, {
      ...base,
      path: REFRESH_PATH,
      maxAge: this.env.REFRESH_TOKEN_TTL_DAYS * 86_400,
    });
    void reply.setCookie(COOKIE.csrf, randomToken(24), {
      ...base,
      httpOnly: false,
      path: "/",
      maxAge: this.env.REFRESH_TOKEN_TTL_DAYS * 86_400,
    });
  }

  async verifyAccess(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ["HS256"] });
      if (typeof payload.sub !== "string" || typeof payload.tid !== "string") return null;
      return { userId: payload.sub, tenantId: payload.tid };
    } catch {
      return null;
    }
  }

  /** Consume a refresh token and return the session it belongs to; throws 401 on any problem */
  async rotate(refreshToken: string): Promise<{ userId: string; tenantId: string | null; familyId: string }> {
    const hash = sha256Hex(refreshToken);
    const record = await this.prisma.client.refreshToken.findUnique({ where: { tokenHash: hash } });
    if (!record || record.expiresAt < new Date()) {
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        "TOKEN_EXPIRED",
        "Session expired, please sign in again",
      );
    }
    if (record.revokedAt) {
      await this.revokeFamily(record.familyId);
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        "UNAUTHENTICATED",
        "Session revoked, please sign in again",
      );
    }
    // Conditional update: two concurrent refreshes with the same token cannot both succeed
    const { count } = await this.prisma.client.refreshToken.updateMany({
      where: { id: record.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) {
      await this.revokeFamily(record.familyId);
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        "UNAUTHENTICATED",
        "Session revoked, please sign in again",
      );
    }
    return { userId: record.userId, tenantId: record.activeTenantId, familyId: record.familyId };
  }

  async revokeByToken(refreshToken: string): Promise<void> {
    const record = await this.prisma.client.refreshToken.findUnique({
      where: { tokenHash: sha256Hex(refreshToken) },
    });
    if (record) await this.revokeFamily(record.familyId);
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.client.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  clearCookies(reply: FastifyReply): void {
    void reply.clearCookie(COOKIE.access, { path: "/" });
    void reply.clearCookie(COOKIE.refresh, { path: REFRESH_PATH });
    void reply.clearCookie(COOKIE.csrf, { path: "/" });
  }
}
