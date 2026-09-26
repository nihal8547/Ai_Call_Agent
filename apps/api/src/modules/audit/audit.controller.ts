import { Controller, Get, Query } from "@nestjs/common";
import { CursorPageQuery } from "@platform/shared";
import { z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, RequirePermissions } from "../../common/auth/decorators";
import { cursorArgs, toPage } from "../../common/http/pagination";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TenantDbService } from "../../infra/tenant-db.service";

const AuditQuery = CursorPageQuery.extend({
  entityType: z.string().max(60).optional(),
  action: z.string().max(80).optional(),
});

@Controller("audit-logs")
export class AuditController {
  constructor(private readonly tenantDb: TenantDbService) {}

  @RequirePermissions("audit:read")
  @Get()
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(AuditQuery)) q: z.output<typeof AuditQuery>,
  ) {
    const rows = await this.tenantDb.db(auth.tenantId).auditLog.findMany({
      where: {
        ...(q.entityType ? { entityType: q.entityType } : {}),
        ...(q.action ? { action: q.action } : {}),
      },
      ...cursorArgs(q.cursor, q.limit),
    });
    return toPage(rows, q.limit);
  }
}
