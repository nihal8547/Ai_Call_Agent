import { Injectable } from "@nestjs/common";
import { type CallSession, type EngineEvent, redactDeep } from "@platform/core";
import type { CallEventType, Prisma } from "@platform/db";
import type { RuntimeEvent, RuntimeTurn } from "@platform/runtime";
import type { AgentConfig } from "@platform/shared";
import { TenantDbService } from "../../infra/tenant-db.service";
import type { CallState } from "./call-state.store";
import { upsertLeadForCall } from "./lead-writer";

type EventRow = { type: CallEventType; payload: Record<string, unknown>; latencyMs?: number };

/** Map engine + runtime events onto the call timeline (step transitions and successful LLM calls are metrics, not events) */
export function timelineEvents(
  turn: RuntimeTurn,
  caller?: { transcript: string; confidence?: number },
): EventRow[] {
  const rows: EventRow[] = [];
  if (caller)
    rows.push({
      type: "USER_TURN",
      payload: { text: caller.transcript, confidence: caller.confidence ?? null },
    });

  for (const e of turn.runtimeEvents as RuntimeEvent[]) {
    if (e.type === "llm_call" && !e.ok)
      rows.push({
        type: "FALLBACK",
        payload: { reason: `llm_${e.error}`, purpose: e.purpose },
        latencyMs: e.latencyMs,
      });
    if (e.type === "retrieval")
      rows.push({
        type: "RAG_RETRIEVAL",
        payload: { answered: e.answered, sources: e.sources, rejected: e.rejected ?? null },
        latencyMs: e.latencyMs,
      });
    if (e.type === "phrase_rejected")
      rows.push({ type: "FALLBACK", payload: { reason: "phrase_rejected", reasons: e.reasons } });
    if (e.type === "guard_blocked")
      rows.push({ type: "GUARD_BLOCKED", payload: { violations: e.violations } });
    if (e.type === "tool_timeout")
      rows.push({ type: "TOOL_CALL", payload: { tool: e.tool, ok: false, error: "timeout" } });
  }
  for (const e of turn.engineEvents as EngineEvent[]) {
    switch (e.type) {
      case "extraction":
        rows.push({
          type: "EXTRACTION",
          payload: { field: e.field, value: e.value, source: e.source, correction: e.correction },
        });
        break;
      case "validation_error":
        rows.push({ type: "VALIDATION_ERROR", payload: { field: e.field, error: e.error } });
        break;
      case "fallback":
        if (e.reason !== "llm_unavailable") rows.push({ type: "FALLBACK", payload: { reason: e.reason } });
        break;
      case "field_skipped":
        rows.push({ type: "FALLBACK", payload: { reason: "field_skipped", field: e.field } });
        break;
      case "question":
        rows.push({ type: "RAG_RETRIEVAL", payload: { question: e.question, answered: e.answered } });
        break;
      case "tool_call":
        rows.push({
          type: "TOOL_CALL",
          payload: {
            tool: e.call.tool,
            stepId: e.call.stepId,
            background: e.call.background,
            phase: "requested",
          },
        });
        break;
      case "tool_result":
        rows.push({
          type: "TOOL_CALL",
          payload: { tool: e.tool, stepId: e.stepId, ok: e.ok, error: e.error ?? null, phase: "result" },
        });
        break;
      case "handoff":
        rows.push({ type: "HANDOFF", payload: { reason: e.reason, transferred: e.transferred } });
        break;
      case "end":
        rows.push({
          type: "CALL_ENDED",
          payload: { reason: e.reason, outcome: e.outcome, qualification: e.qualification },
        });
        break;
      case "step":
        break;
    }
  }
  if (turn.speech) {
    const m = turn.metrics;
    rows.push({
      type: "AGENT_TURN",
      payload: {
        text: turn.speech,
        deterministic: m.deterministic,
        llmCalls: m.llmCalls,
        understandMs: m.understandMs,
        phraseMs: m.phraseMs,
        toolMs: m.toolMs,
      },
      latencyMs: m.totalMs,
    });
  }
  return rows;
}

/** Persists the call record, its timeline, usage and the resulting lead */
@Injectable()
export class CallRecorder {
  constructor(private readonly tenantDb: TenantDbService) {}

  /** Append a turn to the timeline and update the call summary; returns the next event sequence */
  async recordTurn(state: CallState, turn: RuntimeTurn, rows: EventRow[]): Promise<number> {
    const session = turn.output.session;
    let seq = state.eventSeq;
    await this.tenantDb.tx(state.tenantId, async (tx) => {
      if (rows.length) {
        await tx.callEvent.createMany({
          data: rows.map((r) => ({
            tenantId: state.tenantId,
            callId: state.callId,
            seq: seq++,
            type: r.type,
            // Transcripts and values are redacted before they are stored
            payload: redactDeep(r.payload) as Prisma.InputJsonValue,
            latencyMs: r.latencyMs ?? null,
          })),
        });
      }
      await tx.call.update({
        where: { id: state.callId },
        data: {
          totalTurns: { increment: rows.some((r) => r.type === "USER_TURN") ? 1 : 0 },
          fallbackTurns: {
            increment: turn.metrics.deterministic && rows.some((r) => r.type === "USER_TURN") ? 1 : 0,
          },
          collectedData: session.collected as Prisma.InputJsonValue,
          qualificationStatus: session.qualification,
        },
      });
      const usage = [
        { kind: "LLM_INPUT_TOKENS" as const, quantity: turn.metrics.inputTokens },
        { kind: "LLM_OUTPUT_TOKENS" as const, quantity: turn.metrics.outputTokens },
      ].filter((u) => u.quantity > 0);
      if (usage.length) {
        await tx.usageRecord.createMany({
          data: usage.map((u) => ({
            tenantId: state.tenantId,
            callId: state.callId,
            kind: u.kind,
            quantity: BigInt(u.quantity),
            provider: "llm",
          })),
        });
      }
    });
    return seq;
  }

  /** The conversation is over: store the outcome and make sure collected details become a lead */
  async finalize(state: CallState, session: CallSession, config: AgentConfig): Promise<void> {
    await this.tenantDb.tx(state.tenantId, async (tx) => {
      await tx.call.update({
        where: { id: state.callId },
        data: {
          outcome: session.outcome ?? "NONE",
          qualificationStatus: session.qualification,
          collectedData: session.collected as Prisma.InputJsonValue,
          summary: summarize(session, config),
          endedAt: new Date(),
        },
      });
      if (Object.keys(session.collected).length) {
        await upsertLeadForCall(tx, { ...state, collected: session.collected, config });
      }
    });
  }

  async markStatus(
    state: CallState,
    status: "COMPLETED" | "FAILED" | "NO_ANSWER" | "BUSY" | "CANCELED",
    durationSec?: number,
  ): Promise<void> {
    await this.tenantDb.tx(state.tenantId, async (tx) => {
      await tx.call.update({
        where: { id: state.callId },
        data: { status, ...(durationSec !== undefined ? { durationSec } : {}), endedAt: new Date() },
      });
      if (durationSec) {
        await tx.usageRecord.create({
          data: {
            tenantId: state.tenantId,
            callId: state.callId,
            kind: "TELEPHONY_MINUTES",
            quantity: BigInt(Math.ceil(durationSec / 60)),
            provider: "twilio",
          },
        });
      }
    });
  }
}

/** One-line deterministic summary for lists and notifications */
function summarize(session: CallSession, config: AgentConfig): string {
  const labels = new Map(config.qualificationFields.map((f) => [f.key, f.label]));
  const parts = Object.entries(session.collected).map(
    ([k, v]) => `${labels.get(k) ?? k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`,
  );
  const questions = session.pendingQuestions.length
    ? ` Open questions: ${session.pendingQuestions.join(" | ")}`
    : "";
  return `${parts.join("; ") || "No details collected"}.${questions}`.slice(0, 2000);
}
