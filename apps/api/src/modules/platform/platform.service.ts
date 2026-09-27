import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { platformTenants, type PlatformTenant, setTenantPlan, setTenantStatus } from "@platform/db";
import {
  type PlatformPlanBody,
  type PlatformStatusBody,
  type PlatformTenantsQuery,
  TenantLimits,
} from "@platform/shared";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { AppException } from "../../common/filters/problem-details.filter";
import { API_ENV, type ApiEnv } from "../../config/env";
import { PrismaService } from "../../infra/prisma.service";
import { TenantDbService } from "../../infra/tenant-db.service";

type Meta = { ip?: string; userAgent?: string };

/**
 * The platform operator's console: every business, its usage and cost, plans and limits,
 * suspending and reactivating. Only platform owners (users.is_platform_owner) get in; in
 * production they must also use two-step sign-in.
 */
@Injectable()
export class PlatformService {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDbService,
  ) {}

  async assertOwner(auth: AuthContext): Promise<{ userId: string }> {
    if (auth.kind !== "user") throw forbidden();
    const user = await this.prisma.client.user.findUnique({
      where: { id: auth.userId },
      select: { isPlatformOwner: true, totpEnabledAt: true },
    });
    if (!user?.isPlatformOwner) throw forbidden();
    if (this.env.NODE_ENV === "production" && !user.totpEnabledAt)
      throw new AppException(
        HttpStatus.FORBIDDEN,
        "FORBIDDEN",
        "Turn on two-step sign-in (Security) to use the platform console",
      );
    return { userId: auth.userId };
  }

  async list(auth: AuthContext, q: z.output<typeof PlatformTenantsQuery>) {
    await this.assertOwner(auth);
    const all = await platformTenants(this.prisma.client);
    const needle = q.q?.toLowerCase();
    const items = all
      .filter((t) => q.status === "all" || t.status === q.status)
      .filter(
        (t) =>
          !needle ||
          t.name.toLowerCase().includes(needle) ||
          t.slug.toLowerCase().includes(needle) ||
          (t.ownerEmail ?? "").toLowerCase().includes(needle),
      )
      .map(view);
    return {
      items,
      totals: {
        businesses: all.length,
        suspended: all.filter((t) => t.status === "SUSPENDED").length,
        calls30d: sum(all, "calls30d"),
        minutes30d: sum(all, "minutes30d"),
        costMicros30d: sum(all, "costMicros30d"),
        failedJobs: sum(all, "failedJobs"),
      },
    };
  }

  async get(auth: AuthContext, id: string) {
    await this.assertOwner(auth);
    const t = (await platformTenants(this.prisma.client)).find((x) => x.id === id);
    if (!t) throw notFound();
    const history = await this.tenantDb.db(id).auditLog.findMany({
      where: { action: { startsWith: "platform." } },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { action: true, before: true, after: true, createdAt: true, actorId: true },
    });
    const actors = await this.prisma.client.user.findMany({
      where: { id: { in: [...new Set(history.flatMap((h) => (h.actorId ? [h.actorId] : [])))] } },
      select: { id: true, name: true },
    });
    const names = new Map(actors.map((a) => [a.id, a.name]));
    return {
      ...view(t),
      history: history.map((h) => ({
        action: h.action,
        before: h.before,
        after: h.after,
        at: h.createdAt,
        by: h.actorId ? (names.get(h.actorId) ?? "A platform owner") : "The platform",
      })),
    };
  }

  async setStatus(auth: AuthContext, id: string, body: z.output<typeof PlatformStatusBody>, meta: Meta) {
    const { userId } = await this.assertOwner(auth);
    // Suspending the business you're signed in to would lock you out of this console
    if (body.status === "SUSPENDED" && auth.tenantId === id)
      throw new AppException(
        HttpStatus.CONFLICT,
        "CONFLICT",
        "You're signed in to this business: switch to another one to suspend it",
      );
    const before = (await platformTenants(this.prisma.client)).find((x) => x.id === id);
    if (!before) throw notFound();
    await setTenantStatus(this.prisma.client, id, body.status, body.reason ?? null);
    await this.audit(
      id,
      userId,
      `platform.tenant_${body.status === "SUSPENDED" ? "suspended" : "reactivated"}`,
      {
        before: { status: before.status },
        after: { status: body.status, reason: body.reason ?? null },
        ...meta,
      },
    );
    return this.get(auth, id);
  }

  async setPlan(auth: AuthContext, id: string, body: z.output<typeof PlatformPlanBody>, meta: Meta) {
    const { userId } = await this.assertOwner(auth);
    const before = (await platformTenants(this.prisma.client)).find((x) => x.id === id);
    if (!before) throw notFound();
    const limits = TenantLimits.parse({ ...(before.usageLimits as object), ...(body.limits ?? {}) });
    const plan = body.plan ?? before.plan;
    await setTenantPlan(this.prisma.client, id, plan, limits);
    await this.audit(id, userId, "platform.plan_changed", {
      before: { plan: before.plan, limits: TenantLimits.parse(before.usageLimits ?? {}) },
      after: { plan, limits },
      ...meta,
    });
    return this.get(auth, id);
  }

  /** Recorded in the business's own audit log, by the platform owner */
  private async audit(
    tenantId: string,
    userId: string,
    action: string,
    e: { before: unknown; after: unknown; ip?: string; userAgent?: string },
  ) {
    await this.tenantDb.tx(tenantId, (tx) =>
      tx.auditLog.create({
        data: {
          tenantId,
          actorType: "platform",
          actorId: userId,
          action,
          entityType: "tenant",
          entityId: tenantId,
          before: JSON.parse(JSON.stringify(e.before)),
          after: JSON.parse(JSON.stringify(e.after)),
          ip: e.ip ?? null,
          userAgent: e.userAgent?.slice(0, 500) ?? null,
        },
      }),
    );
  }
}

const view = (t: PlatformTenant) => ({
  ...t,
  limits: TenantLimits.parse(t.usageLimits ?? {}),
  usageLimits: undefined,
});
const sum = (rows: PlatformTenant[], k: "calls30d" | "minutes30d" | "costMicros30d" | "failedJobs") =>
  rows.reduce((n, r) => n + r[k], 0);
const forbidden = () => new AppException(HttpStatus.FORBIDDEN, "FORBIDDEN", "Platform owners only");
const notFound = () => new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Business not found");
