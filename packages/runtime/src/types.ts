import type { LLMErrorKind, LLMProvider } from "@platform/ai";
import type { EngineContext, EngineEvent, ToolCall, ToolResult, TurnOutput } from "@platform/core";

/** Executes blocking tools (booking, lookups) for the runtime; implementations live in @platform/tools */
export interface ToolRunner {
  run(call: ToolCall, ctx: EngineContext): Promise<ToolResult>;
}

export type KnowledgeAnswer = { text: string; sources: string[] };

/** Answers caller questions from the business's own knowledge (RAG, phase P10) */
export interface KnowledgeRetriever {
  answer(question: string, opts: { timeoutMs: number }): Promise<KnowledgeAnswer | null>;
}

export type RuntimeDeps = {
  /** null = no LLM configured: every turn uses the deterministic path */
  llm: LLMProvider | null;
  tools: ToolRunner;
  retriever?: KnowledgeRetriever | null;
  toolTimeoutMs?: number;
};

export type RuntimeEvent =
  | {
      type: "llm_call";
      purpose: "understand" | "phrase";
      ok: boolean;
      error?: LLMErrorKind | "schema";
      latencyMs: number;
      model: string;
      inputTokens: number;
      outputTokens: number;
    }
  | {
      type: "retrieval";
      ok: boolean;
      answered: boolean;
      latencyMs: number;
      sources: number;
      rejected?: string;
    }
  | { type: "phrase_rejected"; reasons: string[] }
  | { type: "guard_blocked"; violations: string[] }
  | { type: "tool_timeout"; tool: string };

export type TurnMetrics = {
  totalMs: number;
  understandMs: number;
  retrieveMs: number;
  decideMs: number;
  toolMs: number;
  phraseMs: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** The reply spoken was the deterministic one (no LLM understanding or phrasing used) */
  deterministic: boolean;
};

export type RuntimeTurn = {
  /** Final engine output after any blocking tools ran (segments/events cover the whole turn) */
  output: TurnOutput;
  /** What to say to the caller: phrased by the LLM when valid, otherwise deterministic */
  speech: string;
  engineEvents: EngineEvent[];
  runtimeEvents: RuntimeEvent[];
  metrics: TurnMetrics;
};
