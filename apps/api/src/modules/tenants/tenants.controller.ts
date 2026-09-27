import { Body, Controller, Get, Patch, Req } from "@nestjs/common";
import { COUNTRIES, UpdateTenantBody } from "@platform/shared";
import type { FastifyRequest } from "fastify";
import { type z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, RequirePermissions } from "../../common/auth/decorators";
import { requestMeta } from "../../common/http/request-meta";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AuditService } from "../audit/audit.service";

const tenantView = {
  id: true,
  name: true,
  slug: true,
  industry: true,
  timezone: true,
  country: true,
  callingCode: true,
  currency: true,
  retentionDays: true,
  maxCallMinutes: true,
  status: true,
  plan: true,
  usageLimits: true,
  createdAt: true,
} as const;

@Controller("tenant")
export class TenantsController {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
  ) {}

  @RequirePermissions("tenant:read")
  @Get()
  get(@CurrentAuth() auth: AuthContext) {
    return this.tenantDb
      .db(auth.tenantId)
      .tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: tenantView });
  }

  @RequirePermissions("tenant:write")
  @Patch()
  update(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(UpdateTenantBody)) body: z.output<typeof UpdateTenantBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const before = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: tenantView });
      const data = body.country
        ? {
            ...body,
            callingCode: COUNTRIES[body.country].callingCode,
            currency: COUNTRIES[body.country].currency,
          }
        : body;
      const after = await tx.tenant.update({ where: { id: auth.tenantId }, data, select: tenantView });
      await this.audit.record(tx, auth, {
        action: "tenant.updated",
        entityType: "tenant",
        entityId: auth.tenantId,
        before: pick(before, Object.keys(data)),
        after: pick(after, Object.keys(data)),
        ...requestMeta(req),
      });
      return after;
    });
  }
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}
