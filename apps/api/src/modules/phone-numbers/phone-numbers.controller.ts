import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Req } from "@nestjs/common";
import { CreatePhoneNumberBody, IdParam, UpdatePhoneNumberBody } from "@platform/shared";
import type { FastifyRequest } from "fastify";
import { type z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, RequirePermissions } from "../../common/auth/decorators";
import { AppException } from "../../common/filters/problem-details.filter";
import { requestMeta } from "../../common/http/request-meta";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AuditService } from "../audit/audit.service";

const view = {
  id: true,
  e164: true,
  provider: true,
  providerSid: true,
  friendlyName: true,
  isActive: true,
  createdAt: true,
  agent: { select: { id: true, name: true, status: true } },
} as const;

@Controller("phone-numbers")
export class PhoneNumbersController {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
  ) {}

  @RequirePermissions("phone_numbers:read")
  @Get()
  async list(@CurrentAuth() auth: AuthContext) {
    return {
      items: await this.tenantDb
        .db(auth.tenantId)
        .phoneNumber.findMany({ select: view, orderBy: { createdAt: "asc" } }),
    };
  }

  @RequirePermissions("phone_numbers:write")
  @Post()
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(CreatePhoneNumberBody)) body: z.output<typeof CreatePhoneNumberBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      if (body.agentId) await this.assertAgent(tx, body.agentId);
      const number = await tx.phoneNumber.create({
        data: {
          tenantId: auth.tenantId,
          e164: body.e164,
          friendlyName: body.friendlyName ?? null,
          agentId: body.agentId ?? null,
          providerSid: body.providerSid ?? null,
        },
        select: view,
      });
      await this.audit.record(tx, auth, {
        action: "phone_number.added",
        entityType: "phone_number",
        entityId: number.id,
        after: body,
        ...requestMeta(req),
      });
      return number;
    });
  }

  @RequirePermissions("phone_numbers:write")
  @Patch(":id")
  update(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Body(new ZodValidationPipe(UpdatePhoneNumberBody)) body: z.output<typeof UpdatePhoneNumberBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      if (!(await tx.phoneNumber.count({ where: { id } })))
        throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Phone number not found");
      if (body.agentId) await this.assertAgent(tx, body.agentId);
      const number = await tx.phoneNumber.update({ where: { id }, data: body, select: view });
      await this.audit.record(tx, auth, {
        action: "phone_number.updated",
        entityType: "phone_number",
        entityId: id,
        after: body,
        ...requestMeta(req),
      });
      return number;
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
      const { count } = await tx.phoneNumber.deleteMany({ where: { id } });
      if (!count) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Phone number not found");
      await this.audit.record(tx, auth, {
        action: "phone_number.removed",
        entityType: "phone_number",
        entityId: id,
        ...requestMeta(req),
      });
    });
  }

  private async assertAgent(
    tx: Parameters<Parameters<TenantDbService["tx"]>[1]>[0],
    agentId: string,
  ): Promise<void> {
    // RLS makes another tenant's agent invisible, so it reads as unknown
    if (!(await tx.agent.count({ where: { id: agentId } }))) {
      throw new AppException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Unknown agent", [
        { path: "agentId", message: "Unknown agent" },
      ]);
    }
  }
}
