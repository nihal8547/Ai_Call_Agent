import { Body, Controller, Get, HttpStatus, Param, Patch, Query, Req } from "@nestjs/common";
import { zonedDateTimeToUtc } from "@platform/core";
import type { Appointment, Prisma } from "@platform/db";
import { IdParam, ListAppointmentsQuery, UpdateAppointmentBody } from "@platform/shared";
import { deleteEvent, type GoogleCredentials, moveEvent, ToolError } from "@platform/tools";
import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, RequirePermissions } from "../../common/auth/decorators";
import { AppException } from "../../common/filters/problem-details.filter";
import { cursorArgs, toPage } from "../../common/http/pagination";
import { requestMeta } from "../../common/http/request-meta";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AuditService } from "../audit/audit.service";
import { IntegrationsService } from "../integrations/integrations.service";

const view = {
  id: true,
  title: true,
  startsAt: true,
  endsAt: true,
  timezone: true,
  status: true,
  notes: true,
  externalRef: true,
  rescheduledFromId: true,
  callId: true,
  createdAt: true,
  agent: { select: { id: true, name: true } },
  lead: { select: { id: true, customerName: true, phone: true } },
  integration: { select: { id: true, name: true, type: true } },
} satisfies Prisma.AppointmentSelect;

@Controller()
export class AppointmentsController {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
    private readonly integrations: IntegrationsService,
  ) {}

  @RequirePermissions("appointments:read")
  @Get("appointments")
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(ListAppointmentsQuery)) q: z.output<typeof ListAppointmentsQuery>,
  ) {
    const rows = await this.tenantDb.db(auth.tenantId).appointment.findMany({
      where: {
        ...(q.from || q.to
          ? {
              startsAt: {
                ...(q.from ? { gte: new Date(q.from) } : {}),
                ...(q.to ? { lt: new Date(q.to) } : {}),
              },
            }
          : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.agentId ? { agentId: q.agentId } : {}),
      },
      select: view,
      ...cursorArgs(q.cursor, q.limit),
      // Chronological (the cursor is still the unique id)
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    });
    return toPage(rows, q.limit);
  }

  @RequirePermissions("appointments:read")
  @Get("appointments/:id")
  async get(@CurrentAuth() auth: AuthContext, @Param(new ZodValidationPipe(IdParam)) { id }: { id: string }) {
    const row = await this.tenantDb.db(auth.tenantId).appointment.findUnique({ where: { id }, select: view });
    if (!row) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Appointment not found");
    return row;
  }

  /** Reschedule, cancel, mark attended/no-show, or add notes. Calendar events follow. */
  @RequirePermissions("appointments:write")
  @Patch("appointments/:id")
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Body(new ZodValidationPipe(UpdateAppointmentBody)) body: z.output<typeof UpdateAppointmentBody>,
    @Req() req: FastifyRequest,
  ) {
    const db = this.tenantDb.db(auth.tenantId);
    const current = await db.appointment.findUnique({ where: { id } });
    if (!current) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Appointment not found");
    const changesTime = Boolean(body.reschedule) || body.status === "CANCELLED";
    if (changesTime && current.status !== "UPCOMING")
      throw new AppException(
        HttpStatus.CONFLICT,
        "CONFLICT",
        "Only upcoming appointments can be moved or cancelled",
      );

    if (body.reschedule) return this.reschedule(auth, current, body.reschedule, req);

    if (body.status === "CANCELLED")
      await this.syncCalendar(auth.tenantId, current, (ref, deps) =>
        deleteEvent(ref, current.externalRef!, deps),
      );
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const updated = await tx.appointment.update({
        where: { id },
        data: {
          ...(body.status ? { status: body.status } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
        },
        select: view,
      });
      await this.audit.record(tx, auth, {
        action: body.status === "CANCELLED" ? "appointment.cancelled" : "appointment.updated",
        entityType: "appointment",
        entityId: id,
        before: { status: current.status },
        after: body,
        ...requestMeta(req),
      });
      return updated;
    });
  }

  /** A new appointment replaces the old one (kept as RESCHEDULED for history); the calendar event moves */
  private async reschedule(
    auth: AuthContext,
    current: Appointment,
    to: { date: string; time: string },
    req: FastifyRequest,
  ) {
    const startsAt = zonedDateTimeToUtc(to.date, to.time, current.timezone);
    const endsAt = new Date(startsAt.getTime() + (current.endsAt.getTime() - current.startsAt.getTime()));
    if (startsAt.getTime() <= Date.now())
      throw new AppException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Choose a future time", [
        { path: "reschedule.time", message: "This time has passed" },
      ]);

    await this.syncCalendar(auth.tenantId, current, (ref, deps) =>
      moveEvent(ref, current.externalRef!, startsAt, endsAt, current.timezone, deps),
    );
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      await tx.appointment.update({ where: { id: current.id }, data: { status: "RESCHEDULED" } });
      const next = await tx.appointment.create({
        data: {
          tenantId: auth.tenantId,
          agentId: current.agentId,
          leadId: current.leadId,
          callId: current.callId,
          title: current.title,
          startsAt,
          endsAt,
          timezone: current.timezone,
          status: "UPCOMING",
          externalRef: current.externalRef,
          integrationId: current.integrationId,
          rescheduledFromId: current.id,
          notes: current.notes,
        },
        select: view,
      });
      await this.audit.record(tx, auth, {
        action: "appointment.rescheduled",
        entityType: "appointment",
        entityId: next.id,
        before: { id: current.id, startsAt: current.startsAt },
        after: { startsAt },
        ...requestMeta(req),
      });
      return next;
    });
  }

  /** Apply a change to the linked calendar event first, so the calendar and the platform never disagree */
  private async syncCalendar(
    tenantId: string,
    appt: Appointment,
    change: (
      ref: { credentials: GoogleCredentials; calendarId: string },
      deps: {
        fetch: typeof fetch;
        timeoutMs: number;
        oauthClient?: { clientId: string; clientSecret: string };
      },
    ) => Promise<void>,
  ): Promise<void> {
    if (!appt.externalRef || !appt.integrationId) return;
    const binding = await this.integrations.byId(tenantId, appt.integrationId);
    if (!binding) return; // integration removed: nothing left to keep in sync
    try {
      await change(
        {
          credentials: binding.credentials as GoogleCredentials,
          calendarId: String(binding.config.calendarId ?? "primary"),
        },
        {
          fetch,
          timeoutMs: 8000,
          ...(this.integrations.googleOAuth ? { oauthClient: this.integrations.googleOAuth } : {}),
        },
      );
    } catch (err) {
      const e = err instanceof ToolError ? err : new ToolError("unavailable", "Calendar update failed");
      if (e.kind === "auth" || e.kind === "config")
        await this.integrations.markError(tenantId, binding.integrationId, e.message);
      throw new AppException(
        HttpStatus.BAD_GATEWAY,
        "INTEGRATION_ERROR",
        `Google Calendar could not be updated: ${e.message}`,
      );
    }
  }
}
