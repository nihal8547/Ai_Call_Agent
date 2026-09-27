import { Injectable, Logger } from "@nestjs/common";
import type { ToolCall, ToolResult } from "@platform/core";
import type { TenantTx } from "@platform/db";
import { type AgentConfig, TOOL_BUSINESS_OUTCOMES } from "@platform/shared";
import type { ToolRunner } from "@platform/runtime";
import { type BookingStore, createToolExecutor, type ResultCache, type ToolRunEvent } from "@platform/tools";
import { RedisService } from "../../infra/redis.service";
import { TenantDbService } from "../../infra/tenant-db.service";
import { IntegrationsService } from "../integrations/integrations.service";
import { upsertLeadForCall } from "../telephony/lead-writer";

export type CallToolContext = {
  tenantId: string;
  /** The call the tools run in, or null in a WhatsApp conversation (conversationId) */
  callId: string | null;
  conversationId?: string | null;
  agentId: string;
  callerNumber: string;
  timezone: string;
  config: AgentConfig;
  now?: Date;
};

const CACHE_TTL_SECONDS = 24 * 3600;
const BUSINESS_OUTCOMES = new Set<string>(TOOL_BUSINESS_OUTCOMES);

/** A ToolRunner for one call, plus the executions it performed (for the call timeline) */
export type CallTools = ToolRunner & { drain(): ToolRunEvent[] };

/**
 * Runs an agent's tools during real calls: permission grant, integration binding, decrypted
 * credentials, bookings in Postgres, and a result cache so retries never repeat side effects.
 */
@Injectable()
export class ToolService {
  private readonly logger = new Logger(ToolService.name);

  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly integrations: IntegrationsService,
    private readonly redis: RedisService,
  ) {}

  forCall(t: CallToolContext): CallTools {
    const events: ToolRunEvent[] = [];
    const executor = createToolExecutor(
      { ...t, now: t.now ?? new Date() },
      {
        binding: (tool) => this.integrations.bindingFor(t.tenantId, t.agentId, tool),
        bookings: this.bookings(t),
        saveLead: (collected) =>
          this.tenantDb.tx(t.tenantId, async (tx) => ({
            leadId: (await upsertLeadForCall(tx, { ...t, collected })).id,
          })),
        cache: this.cache(),
        onEvent: (e) => {
          events.push(e);
          if (!e.ok) {
            // A taken slot or a closed day is a normal conversation outcome, not an incident
            const level = BUSINESS_OUTCOMES.has(e.error ?? "") ? "log" : "warn";
            this.logger[level](
              {
                callId: t.callId,
                conversationId: t.conversationId,
                tool: e.tool,
                error: e.error,
                detail: e.detail,
              },
              "tool did not complete",
            );
          }
        },
        onIntegrationError: (integrationId, err) =>
          this.integrations.markError(t.tenantId, integrationId, err.message),
        ...this.integrations.toolNetwork,
        onRefreshToken: (integrationId: string, token: string) =>
          this.integrations.saveRefreshToken(t.tenantId, integrationId, token),
      },
    );
    return {
      run: (call: ToolCall): Promise<ToolResult> => executor.run(call),
      drain: () => events.splice(0),
    };
  }

  private cache(): ResultCache {
    const key = (k: string) => `toolres:${k}`;
    return {
      get: async (k) => {
        const raw = await this.redis.client.get(key(k));
        return raw ? (JSON.parse(raw) as ToolResult) : null;
      },
      set: async (k, v) => {
        await this.redis.client.set(key(k), JSON.stringify(v), "EX", CACHE_TTL_SECONDS);
      },
    };
  }

  /** The platform appointment book for this call's agent */
  private bookings(t: CallToolContext): BookingStore {
    const busyIn = (tx: TenantTx, from: Date, to: Date) =>
      tx.appointment.findMany({
        where: { agentId: t.agentId, status: "UPCOMING", startsAt: { lt: to }, endsAt: { gt: from } },
        select: { startsAt: true, endsAt: true },
      });
    return {
      busy: async (from, to) =>
        (await this.tenantDb.tx(t.tenantId, (tx) => busyIn(tx, from, to))).map((a) => ({
          start: a.startsAt,
          end: a.endsAt,
        })),

      book: (a) =>
        this.tenantDb.tx(t.tenantId, async (tx) => {
          // One booking at a time per agent, so two callers can't both take the last place
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`booking:${t.agentId}`}, 0))`;
          const existing = await tx.appointment.findFirst({
            where: { ...origin(t), startsAt: a.start, status: "UPCOMING" },
          });
          if (existing) return { ok: true as const, appointmentId: existing.id };
          if (a.capacity !== null) {
            const buffer = a.bufferMinutes * 60_000;
            const overlapping = await busyIn(
              tx,
              new Date(a.start.getTime() - buffer),
              new Date(a.end.getTime() + buffer),
            );
            if (overlapping.length >= a.capacity) return { ok: false as const };
          }
          const lead = await upsertLeadForCall(tx, { ...t, collected: a.collected });
          const row = await tx.appointment.create({
            data: {
              tenantId: t.tenantId,
              agentId: t.agentId,
              callId: t.callId,
              conversationId: t.conversationId ?? null,
              leadId: lead.id,
              title: a.title.slice(0, 200),
              startsAt: a.start,
              endsAt: a.end,
              timezone: t.timezone,
              externalRef: a.externalRef ?? null,
              integrationId: a.integrationId ?? null,
            },
          });
          return { ok: true as const, appointmentId: row.id };
        }),

      discard: async (id) => {
        await this.tenantDb.db(t.tenantId).appointment.deleteMany({ where: { id, ...origin(t) } });
      },

      nextForCaller: async () => {
        if (!t.callerNumber) return null;
        const next = await this.tenantDb.db(t.tenantId).appointment.findFirst({
          where: { status: "UPCOMING", startsAt: { gt: new Date() }, lead: { phone: t.callerNumber } },
          orderBy: { startsAt: "asc" },
        });
        return next
          ? {
              id: next.id,
              start: next.startsAt,
              externalRef: next.externalRef,
              integrationId: next.integrationId,
            }
          : null;
      },

      cancel: async (id) => {
        await this.tenantDb
          .db(t.tenantId)
          .appointment.update({ where: { id }, data: { status: "CANCELLED" } });
      },
    };
  }
}

/** Rows created in this call or conversation (a chat has no call id) */
function origin(t: CallToolContext): { callId: string } | { conversationId: string } {
  if (t.callId) return { callId: t.callId };
  if (t.conversationId) return { conversationId: t.conversationId };
  throw new Error("Tools need a call or a conversation");
}
