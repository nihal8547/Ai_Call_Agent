import { Logger } from "@nestjs/common";
import {
  type EngineContext,
  isOpen,
  type ToolCall,
  type ToolResult,
  zonedDateTimeToUtc,
} from "@platform/core";
import type { AgentConfig } from "@platform/shared";
import type { ToolRunner } from "@platform/runtime";
import { z } from "zod";
import { TenantDbService } from "../../infra/tenant-db.service";
import { upsertLeadForCall } from "./lead-writer";

export type ToolContext = {
  tenantId: string;
  callId: string;
  agentId: string;
  callerNumber: string;
  timezone: string;
  config: AgentConfig;
};

const AppointmentInput = z.object({
  title: z.string().trim().min(1).max(200).default("Appointment"),
  date: z.iso.date(),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  collected: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Tools implemented inside the platform (leads and appointments).
 * External integrations (calendar, CRM, sheets, messaging) arrive with the tool registry in P9;
 * until then they report "not available" and the conversation continues gracefully.
 */
export class InternalTools implements ToolRunner {
  private readonly logger = new Logger(InternalTools.name);

  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly t: ToolContext,
  ) {}

  async run(call: ToolCall, _ctx: EngineContext): Promise<ToolResult> {
    // Only tools enabled in the agent's configuration can ever run
    if (!this.t.config.tools.includes(call.tool)) return { ok: false, error: "tool_not_enabled" };
    try {
      switch (call.tool) {
        case "leads.create":
          return await this.createLead(call);
        case "appointments.create":
          return await this.createAppointment(call);
        default:
          return { ok: false, error: "tool_not_available" };
      }
    } catch (err) {
      this.logger.error({ err, tool: call.tool, callId: this.t.callId }, "internal tool failed");
      return { ok: false, error: "tool_error" };
    }
  }

  private collected(call: ToolCall): Record<string, unknown> {
    const c = call.input.collected;
    return c && typeof c === "object" ? (c as Record<string, unknown>) : {};
  }

  private async createLead(call: ToolCall): Promise<ToolResult> {
    const lead = await this.tenantDb.tx(this.t.tenantId, (tx) =>
      upsertLeadForCall(tx, { ...this.t, collected: this.collected(call) }),
    );
    return { ok: true, data: { leadId: lead.id } };
  }

  private async createAppointment(call: ToolCall): Promise<ToolResult> {
    const input = AppointmentInput.safeParse(call.input);
    if (!input.success) return { ok: false, error: "invalid_input" };
    const { title, date, time } = input.data;
    const startsAt = zonedDateTimeToUtc(date, time, this.t.timezone);
    if (startsAt.getTime() < Date.now()) return { ok: false, error: "in_the_past" };
    const minutes = this.t.config.appointment?.durationMinutes ?? 30;
    const endsAt = new Date(startsAt.getTime() + minutes * 60_000);
    // Never confirm a visit when the business is closed (the whole slot must be inside opening hours)
    const hours = this.t.config.workingHours;
    if (hours && (!isOpen(hours, startsAt) || !isOpen(hours, new Date(endsAt.getTime() - 60_000)))) {
      return { ok: false, error: "outside_working_hours" };
    }

    const appointment = await this.tenantDb.tx(this.t.tenantId, async (tx) => {
      // Idempotent: a retried booking for the same call and time returns the existing appointment
      const existing = await tx.appointment.findFirst({ where: { callId: this.t.callId, startsAt } });
      if (existing) return existing;
      const lead = await upsertLeadForCall(tx, { ...this.t, collected: this.collected(call) });
      return tx.appointment.create({
        data: {
          tenantId: this.t.tenantId,
          agentId: this.t.agentId,
          callId: this.t.callId,
          leadId: lead.id,
          title,
          startsAt,
          endsAt,
          timezone: this.t.timezone,
        },
      });
    });
    return { ok: true, data: { appointmentId: appointment.id } };
  }
}
