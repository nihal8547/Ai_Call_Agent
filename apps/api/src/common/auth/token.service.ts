import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { randomToken, sha256Hex } from "@platform/crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { jwtVerify, SignJWT } from "jose";
import { randomUUID } from "node:crypto";
import { API_ENV, type ApiEnv } from "../../config/env";
import { PrismaService } from "../../infra/prisma.service";
import { RedisService } from "../../infra/redis.service";
import { AppException } from "../filters/problem-details.filter";
import { COOKIE } from "./auth.types";

export type AccessClaims = { userId: string; tenantId: string; familyId?: string };

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
    private readonly redis: RedisService,
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
    // `fid` ties the access token to its session, so revoking the session stops it at once
    const access = await new SignJWT({ tid: claims.tenantId, fid: familyId })
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
      const familyId = typeof payload.fid === "string" ? payload.fid : undefined;
      if (familyId && (await this.redis.client.exists(revokedKey(familyId)))) return null;
      return { userId: payload.sub, tenantId: payload.tid, ...(familyId ? { familyId } : {}) };
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
    // Access tokens already issued for it stop working too (they expire on their own after this)
    await this.redis.client.set(revokedKey(familyId), "1", "EX", this.env.ACCESS_TOKEN_TTL_SECONDS + 60);
  }

  /** A user's signed-in devices: one per session family, with its latest use */
  async listSessions(userId: string) {
    const rows = await this.prisma.client.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      select: { familyId: true, createdAt: true, userAgent: true, ip: true },
    });
    const firsts = await this.prisma.client.refreshToken.groupBy({
      by: ["familyId"],
      where: { familyId: { in: rows.map((r) => r.familyId) } },
      _min: { createdAt: true },
    });
    const signedIn = new Map(firsts.map((f) => [f.familyId, f._min.createdAt]));
    return rows.map((r) => ({
      id: r.familyId,
      signedInAt: signedIn.get(r.familyId) ?? r.createdAt,
      lastActiveAt: r.createdAt,
      userAgent: r.userAgent,
      ip: r.ip,
    }));
  }

  /** Only the user's own sessions can be revoked */
  async revokeSession(userId: string, familyId: string): Promise<boolean> {
    const owned = await this.prisma.client.refreshToken.count({ where: { userId, familyId } });
    if (!owned) return false;
    await this.revokeFamily(familyId);
    return true;
  }

  clearCookies(reply: FastifyReply): void {
    void reply.clearCookie(COOKIE.access, { path: "/" });
    void reply.clearCookie(COOKIE.refresh, { path: REFRESH_PATH });
    void reply.clearCookie(COOKIE.csrf, { path: "/" });
  }
}

const revokedKey = (familyId: string) => `revoked:family:${familyId}`;
