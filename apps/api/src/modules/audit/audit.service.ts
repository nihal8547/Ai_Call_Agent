import { Injectable } from "@nestjs/common";
import { Prisma, type TenantTx } from "@platform/db";
import type { AuthContext } from "../../common/auth/auth.types";

export type AuditEntry = {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string;
  userAgent?: string;
};

/** Writes audit rows inside the caller's transaction, so the change and its audit record commit together */
@Injectable()
export class AuditService {
  async record(
    tx: TenantTx,
    auth: AuthContext | { kind: "system"; tenantId: string },
    entry: AuditEntry,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        tenantId: auth.tenantId,
        actorType: auth.kind,
        actorId: auth.kind === "user" ? auth.userId : auth.kind === "api_key" ? auth.apiKeyId : null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: toJson(entry.before),
        after: toJson(entry.after),
        ip: entry.ip ?? null,
        userAgent: entry.userAgent?.slice(0, 500) ?? null,
      },
    });
  }
}

function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === undefined || value === null
    ? Prisma.DbNull
    : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);
}
