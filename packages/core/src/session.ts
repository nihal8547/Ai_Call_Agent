import type { ToolName } from "@platform/shared";
import type { FieldValue } from "./fields";

export type Turn = { role: "caller" | "agent"; text: string };

export type ToolCall = {
  tool: ToolName;
  input: Record<string, unknown>;
  stepId: string;
  background: boolean;
  /** Stable across retries of the same turn, so a tool never runs twice for one decision */
  idempotencyKey: string;
};
export type ToolResult = { ok: true; data?: unknown } | { ok: false; error: string };

export type Awaiting =
  | { kind: "field"; fieldKey: string; prompt: string }
  | { kind: "confirm"; stepId: string; prompt: string }
  | { kind: "tool"; stepId: string; call: ToolCall }
  | null;

/** Mirrors the database enums (calls.outcome, calls.qualification_status) */
export type CallOutcome =
  | "LEAD_CAPTURED"
  | "APPOINTMENT_BOOKED"
  | "ENQUIRY_ANSWERED"
  | "HUMAN_HANDOFF"
  | "FOLLOW_UP_REQUIRED"
  | "ABANDONED"
  | "NONE";
export type QualificationStatus = "NOT_STARTED" | "PARTIAL" | "QUALIFIED" | "DISQUALIFIED";

/**
 * Complete, serialisable state of one call. The engine never mutates its input:
 * every turn returns a new session, which the runtime persists (Redis in production).
 */
export type CallSession = {
  version: 1;
  callId: string;
  stepId: string | null;
  collected: Record<string, FieldValue>;
  attempts: Record<string, number>;
  skipped: string[];
  awaiting: Awaiting;
  greeted: boolean;
  turns: number;
  silentTurns: number;
  llmFailures: number;
  /** Circuit breaker: the runtime stops calling the LLM for the rest of the call */
  fallbackOnly: boolean;
  pendingQuestions: string[];
  answeredQuestions: number;
  toolResults: Record<string, ToolResult>;
  backgroundTools: string[];
  handoff: { requested: boolean; target: string | null; reason: string | null };
  ended: boolean;
  endReason: string | null;
  outcome: CallOutcome | null;
  qualification: QualificationStatus;
  lastPrompt: string | null;
  history: Turn[];
};

export function newSession(callId: string): CallSession {
  return {
    version: 1,
    callId,
    stepId: null,
    collected: {},
    attempts: {},
    skipped: [],
    awaiting: null,
    greeted: false,
    turns: 0,
    silentTurns: 0,
    llmFailures: 0,
    fallbackOnly: false,
    pendingQuestions: [],
    answeredQuestions: 0,
    toolResults: {},
    backgroundTools: [],
    handoff: { requested: false, target: null, reason: null },
    ended: false,
    endReason: null,
    outcome: null,
    qualification: "NOT_STARTED",
    lastPrompt: null,
    history: [],
  };
}
