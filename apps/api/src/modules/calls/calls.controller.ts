import { Controller, Get, HttpStatus, Param, Query } from "@nestjs/common";
import { IdParam, ListCallsQuery } from "@platform/shared";
import { type z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, RequirePermissions } from "../../common/auth/decorators";
import { AppException } from "../../common/filters/problem-details.filter";
import { cursorArgs, toPage } from "../../common/http/pagination";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TenantDbService } from "../../infra/tenant-db.service";

const listView = {
  id: true,
  fromNumber: true,
  toNumber: true,
  direction: true,
  status: true,
  outcome: true,
  qualificationStatus: true,
  startedAt: true,
  endedAt: true,
  durationSec: true,
  totalTurns: true,
  fallbackTurns: true,
  agent: { select: { id: true, name: true } },
} as const;

@Controller("calls")
export class CallsController {
  constructor(private readonly tenantDb: TenantDbService) {}

  @RequirePermissions("calls:read")
  @Get()
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(ListCallsQuery)) q: z.output<typeof ListCallsQuery>,
  ) {
    const rows = await this.tenantDb.db(auth.tenantId).call.findMany({
      where: {
        ...(q.agentId ? { agentId: q.agentId } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.outcome ? { outcome: q.outcome } : {}),
        ...(q.qualification ? { qualificationStatus: q.qualification } : {}),
        ...(q.from || q.to
          ? { startedAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
          : {}),
      },
      select: listView,
      ...cursorArgs(q.cursor, q.limit),
    });
    return toPage(rows, q.limit);
  }

  @RequirePermissions("calls:read")
  @Get(":id")
  async get(@CurrentAuth() auth: AuthContext, @Param(new ZodValidationPipe(IdParam)) { id }: { id: string }) {
    const call = await this.tenantDb.db(auth.tenantId).call.findUnique({
      where: { id },
      select: {
        ...listView,
        collectedData: true,
        summary: true,
        answeredAt: true,
        agentVersion: { select: { id: true, version: true } },
        leads: { select: { id: true, customerName: true, status: { select: { label: true } } } },
        appointments: { select: { id: true, title: true, startsAt: true, status: true } },
      },
    });
    if (!call) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Call not found");
    return call;
  }

  /** The conversation timeline (transcript, extractions, tools, fallbacks) */
  @RequirePermissions("calls:read", "calls:read_transcript")
  @Get(":id/events")
  async events(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
  ) {
    const db = this.tenantDb.db(auth.tenantId);
    const exists = await db.call.count({ where: { id } });
    if (!exists) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Call not found");
    const items = await db.callEvent.findMany({
      where: { callId: id },
      orderBy: { seq: "asc" },
      select: { id: true, seq: true, type: true, payload: true, latencyMs: true, createdAt: true },
    });
    return { items };
  }
}
