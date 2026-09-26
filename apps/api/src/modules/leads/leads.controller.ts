import { Body, Controller, Get, HttpStatus, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { validateFieldValue } from "@platform/core";
import { readJson } from "@platform/db";
import {
  AgentConfig,
  CreateLeadStatusBody,
  type FieldError,
  IdParam,
  ListLeadsQuery,
  UpdateLeadBody,
  UpdateLeadStatusBody,
} from "@platform/shared";
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

const leadView = {
  id: true,
  customerName: true,
  phone: true,
  email: true,
  source: true,
  data: true,
  notes: true,
  followUpAt: true,
  syncedToCrm: true,
  createdAt: true,
  updatedAt: true,
  callId: true,
  status: { select: { id: true, key: true, label: true, color: true } },
  agent: { select: { id: true, name: true } },
  assignee: { select: { id: true, user: { select: { name: true } } } },
} as const;

@Controller()
export class LeadsController {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
  ) {}

  @RequirePermissions("leads:read")
  @Get("leads")
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(ListLeadsQuery)) q: z.output<typeof ListLeadsQuery>,
  ) {
    const rows = await this.tenantDb.db(auth.tenantId).lead.findMany({
      where: {
        ...(q.statusId ? { statusId: q.statusId } : {}),
        ...(q.agentId ? { agentId: q.agentId } : {}),
        ...(q.q
          ? {
              OR: [
                { customerName: { contains: q.q, mode: "insensitive" as const } },
                { phone: { contains: q.q } },
                { email: { contains: q.q, mode: "insensitive" as const } },
              ],
            }
          : {}),
      },
      select: leadView,
      ...cursorArgs(q.cursor, q.limit),
    });
    return toPage(rows, q.limit);
  }

  @RequirePermissions("leads:read")
  @Get("leads/:id")
  async get(@CurrentAuth() auth: AuthContext, @Param(new ZodValidationPipe(IdParam)) { id }: { id: string }) {
    const lead = await this.tenantDb.db(auth.tenantId).lead.findUnique({
      where: { id },
      select: {
        ...leadView,
        appointments: { select: { id: true, title: true, startsAt: true, status: true } },
      },
    });
    if (!lead) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Lead not found");
    return { ...lead, fields: await this.fieldsFor(auth.tenantId, lead.agent?.id) };
  }

  @RequirePermissions("leads:write")
  @Patch("leads/:id")
  update(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Body(new ZodValidationPipe(UpdateLeadBody)) body: z.output<typeof UpdateLeadBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const lead = await tx.lead.findUnique({ where: { id } });
      if (!lead) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Lead not found");
      if (body.statusId && !(await tx.leadStatus.count({ where: { id: body.statusId } }))) {
        throw new AppException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Unknown status", [
          { path: "statusId", message: "Unknown status" },
        ]);
      }
      if (body.assigneeId && !(await tx.membership.count({ where: { id: body.assigneeId } }))) {
        throw new AppException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Unknown member", [
          { path: "assigneeId", message: "Unknown member" },
        ]);
      }

      let data: Record<string, unknown> | undefined;
      if (body.data) {
        // Qualification answers follow the same rules as on a call
        const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId } });
        const fields = await this.fieldsFor(auth.tenantId, lead.agentId ?? undefined);
        const errors: FieldError[] = [];
        data = { ...(lead.data as Record<string, unknown>) };
        for (const [key, raw] of Object.entries(body.data)) {
          const field = fields.find((f) => f.key === key);
          if (!field) {
            errors.push({ path: `data.${key}`, message: "Unknown field" });
            continue;
          }
          if (raw === null) {
            delete data[key];
            continue;
          }
          const r = validateFieldValue(field, raw, { now: new Date(), timezone: tenant.timezone });
          if (r.ok) data[key] = r.value;
          else errors.push({ path: `data.${key}`, message: r.error });
        }
        if (errors.length)
          throw new AppException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Invalid lead details", errors);
      }

      const { data: _ignored, ...rest } = body;
      const updated = await tx.lead.update({
        where: { id },
        data: { ...rest, ...(data ? { data: data as object } : {}) },
        select: leadView,
      });
      await this.audit.record(tx, auth, {
        action: "lead.updated",
        entityType: "lead",
        entityId: id,
        after: { ...rest, ...(data ? { data } : {}) },
        ...requestMeta(req),
      });
      return updated;
    });
  }

  @RequirePermissions("leads:read")
  @Get("lead-statuses")
  async statuses(@CurrentAuth() auth: AuthContext) {
    return {
      items: await this.tenantDb.db(auth.tenantId).leadStatus.findMany({ orderBy: { sortOrder: "asc" } }),
    };
  }

  @RequirePermissions("leads:write")
  @Post("lead-statuses")
  createStatus(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(CreateLeadStatusBody)) body: z.output<typeof CreateLeadStatusBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      if (body.isDefault) await tx.leadStatus.updateMany({ data: { isDefault: false } });
      const status = await tx.leadStatus.create({ data: { tenantId: auth.tenantId, ...body } });
      await this.audit.record(tx, auth, {
        action: "lead_status.created",
        entityType: "lead_status",
        entityId: status.id,
        after: body,
        ...requestMeta(req),
      });
      return status;
    });
  }

  @RequirePermissions("leads:write")
  @Patch("lead-statuses/:id")
  updateStatus(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Body(new ZodValidationPipe(UpdateLeadStatusBody)) body: z.output<typeof UpdateLeadStatusBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      if (!(await tx.leadStatus.count({ where: { id } })))
        throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Status not found");
      if (body.isDefault)
        await tx.leadStatus.updateMany({ where: { id: { not: id } }, data: { isDefault: false } });
      const status = await tx.leadStatus.update({ where: { id }, data: body });
      await this.audit.record(tx, auth, {
        action: "lead_status.updated",
        entityType: "lead_status",
        entityId: id,
        after: body,
        ...requestMeta(req),
      });
      return status;
    });
  }

  /** Field definitions from the agent's published configuration */
  private async fieldsFor(tenantId: string, agentId: string | undefined) {
    if (!agentId) return [];
    const agent = await this.tenantDb
      .db(tenantId)
      .agent.findUnique({ where: { id: agentId }, include: { publishedVersion: true } });
    if (!agent?.publishedVersion) return [];
    return readJson(AgentConfig, agent.publishedVersion.config, "agent_versions.config").qualificationFields;
  }
}
