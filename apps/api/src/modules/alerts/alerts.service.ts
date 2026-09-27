import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@platform/db";
import type { AuthContext } from "../../common/auth/auth.types";
import { AppException } from "../../common/filters/problem-details.filter";
import { QueueService } from "../../infra/queue.service";
import { TenantDbService } from "../../infra/tenant-db.service";

export type AlertKind = "usage_limit" | "call_spike" | "sip_trunk_silent" | "blocked_caller_burst";

/**
 * Things the business owner must hear about (a plan limit reached, unusual call volume, a trunk
 * that went quiet). One open alert per dedupe key; owners are emailed through the business's own
 * email integration when it has one, and see every alert on the dashboard.
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly queues: QueueService,
  ) {}

  /** Returns true when this is a new alert (not already open) */
  async raise(
    tenantId: string,
    a: { kind: AlertKind; dedupeKey: string; message: string; data?: Record<string, unknown> },
  ): Promise<boolean> {
    const created = await this.tenantDb
      .db(tenantId)
      .tenantAlert.create({
        data: {
          tenantId,
          kind: a.kind,
          dedupeKey: a.dedupeKey.slice(0, 120),
          message: a.message.slice(0, 500),
          data: (a.data ?? {}) as Prisma.InputJsonObject,
        },
      })
      .then(() => true)
      .catch((err: unknown) => {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
        throw err;
      });
    if (!created) return false;
    this.logger.warn({ tenantId, kind: a.kind, alert: a.message }, "tenant alert raised");
    await this.emailOwners(tenantId, a).catch((err: unknown) =>
      this.logger.warn({ err, tenantId }, "could not queue the alert email"),
    );
    return true;
  }

  private async emailOwners(tenantId: string, a: { kind: string; dedupeKey: string; message: string }) {
    const db = this.tenantDb.db(tenantId);
    const hasMail = await db.integration.count({ where: { type: "EMAIL_SMTP", status: "CONNECTED" } });
    if (!hasMail) return;
    const owners = await db.membership.findMany({
      where: { role: { key: "OWNER" } },
      select: { user: { select: { email: true } } },
    });
    const to = owners.map((o) => o.user.email).slice(0, 5);
    if (!to.length) return;
    await this.queues.add(
      "notifications",
      {
        kind: "email",
        tenantId,
        label: `Alert email: ${a.message.slice(0, 80)}`,
        to,
        subject: `Action needed: ${a.message.slice(0, 120)}`,
        text: `${a.message}\n\nSee the dashboard for details. You receive this because you own this business account.`,
        idempotencyKey: `alert:${a.dedupeKey}`,
      },
      `alert-${tenantId}-${a.dedupeKey}`,
    );
  }

  list(tenantId: string, open: boolean) {
    return this.tenantDb.db(tenantId).tenantAlert.findMany({
      where: open ? { acknowledgedAt: null } : {},
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  async acknowledge(auth: AuthContext, id: string) {
    const { count } = await this.tenantDb
      .db(auth.tenantId)
      .tenantAlert.updateMany({ where: { id, acknowledgedAt: null }, data: { acknowledgedAt: new Date() } });
    if (!count) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Alert not found or already dismissed");
  }
}
