import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import type { FailedJobStatus, Prisma, TenantTx } from "@platform/db";
import type { QueueJob } from "@platform/shared";
import type { Job } from "bullmq";
import type { AuthContext } from "../../common/auth/auth.types";
import { AppException } from "../../common/filters/problem-details.filter";
import { QueueService } from "../../infra/queue.service";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AuditService } from "../audit/audit.service";

type Meta = { ip?: string; userAgent?: string };
type TenantQueue = "webhooks" | "notifications" | "crm";

const VIEW = {
  id: true,
  queue: true,
  name: true,
  label: true,
  error: true,
  attempts: true,
  status: true,
  callId: true,
  leadId: true,
  integrationId: true,
  createdAt: true,
  resolvedAt: true,
} as const;

/**
 * Jobs that used up their retries land here, per tenant, so staff can see what didn't reach its
 * destination (a webhook, an email, a CRM) and send it again once the cause is fixed.
 */
@Injectable()
export class DeadLetterService {
  private readonly logger = new Logger(DeadLetterService.name);

  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly queues: QueueService,
    private readonly audit: AuditService,
  ) {}

  async record(queue: TenantQueue, job: Job<QueueJob>, err: Error): Promise<void> {
    const d = job.data;
    const row = {
      tenantId: d.tenantId,
      queue,
      name: job.name.slice(0, 80),
      jobId: job.id!,
      label: d.label.slice(0, 200),
      payload: d as unknown as Prisma.InputJsonValue,
      error: err.message.slice(0, 1000),
      attempts: job.attemptsMade,
      callId: "callId" in d ? (d.callId ?? null) : null,
      leadId: "leadId" in d ? d.leadId : null,
      integrationId: "integrationId" in d ? d.integrationId : null,
    };
    await this.tenantDb.tx(d.tenantId, (tx) =>
      tx.failedJob.upsert({
        where: { queue_jobId: { queue, jobId: row.jobId } },
        create: row,
        update: { error: row.error, attempts: row.attempts, status: "FAILED", resolvedAt: null },
      }),
    );
    this.logger.warn({ queue, jobId: job.id, tenantId: d.tenantId, error: row.error }, "job failed for good");
  }

  async list(tenantId: string, status: FailedJobStatus | undefined, limit: number) {
    return this.tenantDb.tx(tenantId, async (tx) => {
      const where = status ? { status } : {};
      const [items, open] = await Promise.all([
        tx.failedJob.findMany({ where, orderBy: { createdAt: "desc" }, take: limit, select: VIEW }),
        tx.failedJob.count({ where: { status: "FAILED" } }),
      ]);
      return { items, open };
    });
  }

  /** Send the same job again (a fresh job id, the original payload) */
  async retry(auth: AuthContext, id: string, meta: Meta) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const row = await this.open(tx, id);
      const updated = await tx.failedJob.update({
        where: { id },
        data: { status: "RETRIED", resolvedAt: new Date(), resolvedBy: actorId(auth) },
        select: VIEW,
      });
      await this.audit.record(tx, auth, {
        action: "job.retried",
        entityType: "failed_job",
        entityId: id,
        after: { queue: row.queue, label: row.label },
        ...meta,
      });
      // Last, so a failed enqueue rolls the status back
      const payload = row.payload as unknown as QueueJob;
      await this.queues.add(row.queue as TenantQueue, payload, `${row.jobId}-r${Date.now()}`);
      return updated;
    });
  }

  async dismiss(auth: AuthContext, id: string, meta: Meta) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const row = await this.open(tx, id);
      const updated = await tx.failedJob.update({
        where: { id },
        data: { status: "DISMISSED", resolvedAt: new Date(), resolvedBy: actorId(auth) },
        select: VIEW,
      });
      await this.audit.record(tx, auth, {
        action: "job.dismissed",
        entityType: "failed_job",
        entityId: id,
        after: { queue: row.queue, label: row.label },
        ...meta,
      });
      return updated;
    });
  }

  private async open(tx: TenantTx, id: string) {
    const row = await tx.failedJob.findUnique({ where: { id } });
    if (!row) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Failed job not found");
    if (row.status !== "FAILED")
      throw new AppException(HttpStatus.CONFLICT, "CONFLICT", "This job was already retried or dismissed");
    return row;
  }
}

function actorId(auth: AuthContext): string | null {
  return auth.kind === "user" ? auth.userId : auth.kind === "api_key" ? auth.apiKeyId : null;
}
