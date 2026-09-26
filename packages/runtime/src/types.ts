import type { LLMErrorKind, LLMProvider } from "@platform/ai";
import type { EngineContext, EngineEvent, ToolCall, ToolResult, TurnOutput } from "@platform/core";

/** Executes blocking tools (booking, lookups) for the runtime; implementations live in @platform/tools */
export interface ToolRunner {
  run(call: ToolCall, ctx: EngineContext): Promise<ToolResult>;
}

/** Where a spoken answer came from (shown on the call timeline) */
export type KnowledgeSource = {
  chunkId: string;
  documentId: string;
  title: string;
  page?: number;
  headingPath?: string[];
};

export type KnowledgeAnswer = {
  text: string;
  sources: KnowledgeSource[];
  method: "generated" | "extractive";
};

export type RetrievalHit = {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  score: number;
  vectorScore: number | null;
  textScore: number | null;
  /** Passed the relevance gate */
  relevant: boolean;
};

/** Result of searching the agent's knowledge; passed back unchanged to `answer` */
export type KnowledgeSearchResult = {
  query: string;
  mode: string;
  hits: RetrievalHit[];
  passages: unknown[];
  latencyMs: number;
  reason?: string;
};

/** Answers caller questions from the business's own knowledge (implemented by @platform/rag) */
export interface KnowledgeRetriever {
  search(query: string, opts: { timeoutMs: number }): Promise<KnowledgeSearchResult>;
  answer(
    question: string,
    found: KnowledgeSearchResult,
    opts: { timeoutMs: number },
  ): Promise<{
    answer: KnowledgeAnswer | null;
    failure?: string;
    detail?: string;
    llmMs?: number;
    usedChunkIds: string[];
  }>;
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
      query?: string;
      mode?: string;
      /** Search started in parallel with understanding (the caller's words looked like a question) */
      speculative?: boolean;
      method?: KnowledgeAnswer["method"];
      /** Why no knowledge answer was given (no collections, nothing relevant, not in sources, …) */
      reason?: string;
      detail?: string;
      searchMs?: number;
      answerMs?: number;
      hits?: (Pick<RetrievalHit, "chunkId" | "documentId" | "documentTitle" | "vectorScore" | "relevant"> & {
        score: number;
        used: boolean;
      })[];
      used?: KnowledgeSource[];
    }
  | { type: "phrase_rejected"; reasons: string[] }
  /** Understanding/tools used most of the turn's latency budget, so the reply was not rephrased */
  | { type: "phrase_skipped"; reason: "latency_budget"; spentMs: number }
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
