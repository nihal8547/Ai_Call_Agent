import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req } from "@nestjs/common";
import { Prisma } from "@platform/db";
import { BlockCallerBody, IdParam } from "@platform/shared";
import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, RequirePermissions } from "../../common/auth/decorators";
import { AppException } from "../../common/filters/problem-details.filter";
import { requestMeta } from "../../common/http/request-meta";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AuditService } from "../audit/audit.service";
import { TenantSettingsService } from "../telephony/tenant-settings.service";

/** Callers the agents never answer (spam, abuse, premium-rate ranges used for toll fraud) */
@Controller("blocked-callers")
export class BlockedCallersController {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
    private readonly settings: TenantSettingsService,
  ) {}

  @RequirePermissions("phone_numbers:read")
  @Get()
  async list(@CurrentAuth() auth: AuthContext) {
    return {
      items: await this.tenantDb.db(auth.tenantId).blockedCaller.findMany({ orderBy: { createdAt: "desc" } }),
    };
  }

  @RequirePermissions("phone_numbers:write")
  @Post()
  add(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(BlockCallerBody)) body: z.output<typeof BlockCallerBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const row = await tx.blockedCaller
        .create({ data: { tenantId: auth.tenantId, pattern: body.pattern, reason: body.reason ?? null } })
        .catch((err: unknown) => {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
            throw new AppException(HttpStatus.CONFLICT, "CONFLICT", "Already blocked", [
              { path: "pattern", message: "Already blocked" },
            ]);
          throw err;
        });
      await this.audit.record(tx, auth, {
        action: "caller.blocked",
        entityType: "blocked_caller",
        entityId: row.id,
        after: body,
        ...requestMeta(req),
      });
      this.settings.forget(auth.tenantId);
      return row;
    });
  }

  @RequirePermissions("phone_numbers:write")
  @Delete(":id")
  @HttpCode(204)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Req() req: FastifyRequest,
  ): Promise<void> {
    await this.tenantDb.tx(auth.tenantId, async (tx) => {
      const { count } = await tx.blockedCaller.deleteMany({ where: { id } });
      if (!count) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Not found");
      await this.audit.record(tx, auth, {
        action: "caller.unblocked",
        entityType: "blocked_caller",
        entityId: id,
        ...requestMeta(req),
      });
    });
    this.settings.forget(auth.tenantId);
  }
}
