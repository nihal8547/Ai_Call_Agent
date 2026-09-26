import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Query,
  Req,
} from "@nestjs/common";
import { CursorPageQuery, IdParam, UpdateMemberBody } from "@platform/shared";
import type { FastifyRequest } from "fastify";
import { type z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, RequirePermissions } from "../../common/auth/decorators";
import { AppException } from "../../common/filters/problem-details.filter";
import { cursorArgs, toPage } from "../../common/http/pagination";
import { requestMeta } from "../../common/http/request-meta";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AuditService } from "../audit/audit.service";
import { assertCanGrant, assertNotLastOwner } from "./access-policy";

const memberView = {
  id: true,
  createdAt: true,
  user: { select: { id: true, email: true, name: true, lastLoginAt: true } },
  role: { select: { id: true, key: true, name: true } },
} as const;

@Controller("members")
export class MembersController {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
  ) {}

  @RequirePermissions("users:read")
  @Get()
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(CursorPageQuery)) q: CursorPageQuery,
  ) {
    const rows = await this.tenantDb
      .db(auth.tenantId)
      .membership.findMany({ select: memberView, ...cursorArgs(q.cursor, q.limit) });
    return toPage(rows, q.limit);
  }

  @RequirePermissions("users:write")
  @Patch(":id")
  update(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Body(new ZodValidationPipe(UpdateMemberBody)) body: z.output<typeof UpdateMemberBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const member = await tx.membership.findUnique({ where: { id }, include: { role: true } });
      if (!member) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Member not found");
      const newRole = await tx.role.findUnique({ where: { id: body.roleId } });
      if (!newRole)
        throw new AppException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Unknown role", [
          { path: "roleId", message: "Unknown role" },
        ]);

      // You may only manage people whose current and new roles are within your own permissions
      assertCanGrant(auth, member.role.permissions);
      assertCanGrant(auth, newRole.permissions);
      if (newRole.key !== "OWNER") await assertNotLastOwner(tx, id);

      const updated = await tx.membership.update({
        where: { id },
        data: { roleId: newRole.id },
        select: memberView,
      });
      await this.audit.record(tx, auth, {
        action: "member.role_changed",
        entityType: "membership",
        entityId: id,
        before: { role: member.role.key },
        after: { role: newRole.key },
        ...requestMeta(req),
      });
      return updated;
    });
  }

  @RequirePermissions("users:write")
  @Delete(":id")
  @HttpCode(204)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Req() req: FastifyRequest,
  ): Promise<void> {
    await this.tenantDb.tx(auth.tenantId, async (tx) => {
      const member = await tx.membership.findUnique({ where: { id }, include: { role: true, user: true } });
      if (!member) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Member not found");
      assertCanGrant(auth, member.role.permissions);
      await assertNotLastOwner(tx, id);
      await tx.membership.delete({ where: { id } });
      await this.audit.record(tx, auth, {
        action: "member.removed",
        entityType: "membership",
        entityId: id,
        before: { email: member.user.email, role: member.role.key },
        ...requestMeta(req),
      });
    });
  }
}
