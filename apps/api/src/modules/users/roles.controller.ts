import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Req } from "@nestjs/common";
import { CreateRoleBody, IdParam, PERMISSIONS, UpdateRoleBody } from "@platform/shared";
import type { FastifyRequest } from "fastify";
import { type z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, RequirePermissions } from "../../common/auth/decorators";
import { AppException } from "../../common/filters/problem-details.filter";
import { requestMeta } from "../../common/http/request-meta";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AuditService } from "../audit/audit.service";
import { assertCanGrant } from "./access-policy";

@Controller("roles")
export class RolesController {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
  ) {}

  @RequirePermissions("roles:read")
  @Get()
  async list(@CurrentAuth() auth: AuthContext) {
    const roles = await this.tenantDb.db(auth.tenantId).role.findMany({
      orderBy: [{ isSystem: "desc" }, { name: "asc" }],
      include: { _count: { select: { memberships: true } } },
    });
    return { items: roles.map(({ _count, ...r }) => ({ ...r, memberCount: _count.memberships })) };
  }

  /** The permission catalogue, for the role editor */
  @RequirePermissions("roles:read")
  @Get("permissions")
  permissions() {
    return { items: PERMISSIONS };
  }

  @RequirePermissions("roles:write")
  @Post()
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(CreateRoleBody)) body: z.output<typeof CreateRoleBody>,
    @Req() req: FastifyRequest,
  ) {
    assertCanGrant(auth, body.permissions);
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const role = await tx.role.create({ data: { tenantId: auth.tenantId, ...body } });
      await this.audit.record(tx, auth, {
        action: "role.created",
        entityType: "role",
        entityId: role.id,
        after: body,
        ...requestMeta(req),
      });
      return role;
    });
  }

  @RequirePermissions("roles:write")
  @Patch(":id")
  update(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Body(new ZodValidationPipe(UpdateRoleBody)) body: z.output<typeof UpdateRoleBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const role = await this.findCustomRole(tx, id);
      assertCanGrant(auth, role.permissions);
      if (body.permissions) assertCanGrant(auth, body.permissions);
      const updated = await tx.role.update({ where: { id }, data: body });
      await this.audit.record(tx, auth, {
        action: "role.updated",
        entityType: "role",
        entityId: id,
        before: { name: role.name, permissions: role.permissions },
        after: body,
        ...requestMeta(req),
      });
      return updated;
    });
  }

  @RequirePermissions("roles:write")
  @Delete(":id")
  @HttpCode(204)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Req() req: FastifyRequest,
  ): Promise<void> {
    await this.tenantDb.tx(auth.tenantId, async (tx) => {
      const role = await this.findCustomRole(tx, id);
      assertCanGrant(auth, role.permissions);
      const [members, invites] = await Promise.all([
        tx.membership.count({ where: { roleId: id } }),
        tx.invitation.count({ where: { roleId: id, acceptedAt: null } }),
      ]);
      if (members + invites > 0) {
        throw new AppException(
          HttpStatus.CONFLICT,
          "CONFLICT",
          "Reassign members and pending invitations before deleting this role",
        );
      }
      await tx.role.delete({ where: { id } });
      await this.audit.record(tx, auth, {
        action: "role.deleted",
        entityType: "role",
        entityId: id,
        before: { key: role.key },
        ...requestMeta(req),
      });
    });
  }

  private async findCustomRole(tx: Parameters<Parameters<TenantDbService["tx"]>[1]>[0], id: string) {
    const role = await tx.role.findUnique({ where: { id } });
    if (!role) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Role not found");
    if (role.isSystem)
      throw new AppException(
        HttpStatus.CONFLICT,
        "CONFLICT",
        "System roles cannot be changed; create a custom role instead",
      );
    return role;
  }
}
