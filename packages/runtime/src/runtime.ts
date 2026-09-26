import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import {
  buildExtractionJsonSchema,
  type CallSession,
  detectQuestion,
  type EngineContext,
  type EngineEvent,
  guardOutput,
  handleTurn,
  resumeAfterTool,
  startCall,
  type ToolResult,
  type TurnOutput,
  type Understanding,
} from "@platform/core";
import type { AgentConfig } from "@platform/shared";
import { checkPhrase } from "./phrase-check";
import { LlmPhrase, LlmUnderstanding, PHRASE_SCHEMA, phrasePrompt, understandPrompt } from "./prompts";
import type {
  KnowledgeRetriever,
  KnowledgeSearchResult,
  RuntimeDeps,
  RuntimeEvent,
  RuntimeTurn,
  TurnMetrics,
} from "./types";

/** Searching the knowledge base (query embedding + SQL); slow embeddings fall back to keywords */
const SEARCH_TIMEOUT_MS = 900;
const PHRASE_TIMEOUT_MS = 2000;
/**
 * A caller hears silence while the turn runs. Rephrasing is polish, so it only gets what is left
 * of this budget after understanding, retrieval and tools, and is skipped when too little remains.
 */
const TURN_BUDGET_MS = 3000;
const MIN_PHRASE_MS = 700;
/** Upper bound for writing a knowledge answer with the LLM */
const ANSWER_TIMEOUT_MS = 2000;

const State = Annotation.Root({
  // inputs
  config: Annotation<AgentConfig>,
  ctx: Annotation<EngineContext>,
  session: Annotation<CallSession>,
  transcript: Annotation<string>,
  confidence: Annotation<number | undefined>,
  // produced by nodes
  understanding: Annotation<Understanding | null>,
  llmError: Annotation<boolean>,
  question: Annotation<string | null>,
  /** Knowledge search started alongside understanding (the transcript looked like a question) */
  search: Annotation<KnowledgeSearchResult | null>,
  answer: Annotation<string | null>,
  output: Annotation<TurnOutput | null>,
  speech: Annotation<string>,
  phrased: Annotation<boolean>,
  engineEvents: Annotation<EngineEvent[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  runtimeEvents: Annotation<RuntimeEvent[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  metrics: Annotation<Partial<TurnMetrics>>({
    reducer: (a, b) => {
      const merged: Partial<TurnMetrics> = { ...a };
      for (const [k, v] of Object.entries(b) as [keyof TurnMetrics, number | boolean][]) {
        const prev = merged[k];
        (merged as Record<string, unknown>)[k] =
          typeof v === "number" && typeof prev === "number" ? prev + v : v;
      }
      return merged;
    },
    default: () => ({}),
  }),
});
type S = typeof State.State;

/**
 * One conversational turn as a LangGraph:
 *
 *   understand ─┬─(question & knowledge)→ retrieve ─┐
 *               └────────────────────────────────── decide → phrase → guard → END
 *
 * Every node degrades instead of failing: no LLM / LLM error → deterministic understanding;
 * retrieval miss → safe answer; invalid phrasing → deterministic wording; guard failure → fallback text.
 */
export function createRuntime(deps: RuntimeDeps) {
  const toolTimeoutMs = deps.toolTimeoutMs ?? 8000;

  /**
   * Understanding, plus a speculative knowledge search when the caller's words already look like a
   * question: both run at once, so a question costs max(understand, search) rather than the sum.
   */
  const understand = async (s: S): Promise<Partial<S>> => {
    const speculative =
      deps.retriever &&
      s.config.workflow.answerQuestions &&
      s.transcript.trim() &&
      detectQuestion(s.transcript)
        ? searchSafely(s.transcript)
        : null;
    const understood = await understandWithLlm(s);
    return { ...understood, search: speculative ? await speculative : null };
  };

  const searchSafely = async (query: string): Promise<KnowledgeSearchResult | null> => {
    try {
      return await withTimeout(
        deps.retriever!.search(query, { timeoutMs: SEARCH_TIMEOUT_MS }),
        SEARCH_TIMEOUT_MS + 200,
      );
    } catch {
      return null;
    }
  };

  const understandWithLlm = async (s: S): Promise<Partial<S>> => {
    const llm = deps.llm;
    if (!llm || s.session.fallbackOnly || !s.transcript.trim())
      return { understanding: null, llmError: false };
    const { system, user } = understandPrompt(s.config, s.session, s.transcript);
    const r = await llm.generate({
      model: s.config.llm.model,
      system,
      messages: [{ role: "user", content: user }],
      temperature: 0,
      timeoutMs: s.config.llm.timeoutMs,
      jsonSchema: buildExtractionJsonSchema(s.config.qualificationFields),
    });
    const base = { purpose: "understand" as const, latencyMs: r.latencyMs, model: r.model };
    if (!r.ok) {
      return {
        understanding: null,
        llmError: true,
        runtimeEvents: [
          { type: "llm_call", ...base, ok: false, error: r.error, inputTokens: 0, outputTokens: 0 },
        ],
        metrics: { understandMs: r.latencyMs, llmCalls: 1 },
      };
    }
    const parsed = LlmUnderstanding.safeParse(r.json);
    const usage = { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens };
    const metrics = { understandMs: r.latencyMs, llmCalls: 1, ...usage };
    if (!parsed.success) {
      return {
        understanding: null,
        llmError: true,
        runtimeEvents: [{ type: "llm_call", ...base, ...usage, ok: false, error: "schema" }],
        metrics,
      };
    }
    return {
      understanding: {
        intent: parsed.data.intent,
        fields: parsed.data.fields,
        question: parsed.data.question ?? null,
      },
      llmError: false,
      runtimeEvents: [{ type: "llm_call", ...base, ...usage, ok: true }],
      metrics,
    };
  };

  const shouldRetrieve = (s: S): "retrieve" | "decide" => {
    if (!deps.retriever || !s.config.workflow.answerQuestions || !s.transcript.trim()) return "decide";
    const intent = s.understanding?.intent;
    const asked = intent ? intent === "question" || intent === "both" : detectQuestion(s.transcript);
    return asked ? "retrieve" : "decide";
  };

  const retrieve = async (s: S): Promise<Partial<S>> => {
    const question = s.understanding?.question || s.transcript;
    const started = Date.now();
    const speculative = Boolean(s.search);
    const found = s.search ?? (await searchSafely(question));
    const searchMs = speculative ? (s.search?.latencyMs ?? 0) : Date.now() - started;

    // Whatever is left of the turn's budget goes to writing the answer (quoting needs no LLM time)
    const m = s.metrics;
    const spent = (m.understandMs ?? 0) + (speculative ? 0 : searchMs);
    const answerBudget = Math.max(0, Math.min(ANSWER_TIMEOUT_MS, TURN_BUDGET_MS - spent));

    let result: Awaited<ReturnType<KnowledgeRetriever["answer"]>> | null = null;
    let failed = !found;
    const answerStarted = Date.now();
    if (found) {
      try {
        result = await withTimeout(
          deps.retriever!.answer(question, found, { timeoutMs: answerBudget }),
          answerBudget + 500,
        );
      } catch {
        failed = true;
      }
    }
    const answerMs = Date.now() - answerStarted;

    let answer = result?.answer?.text?.trim() || null;
    let rejected: string | undefined;
    if (answer) {
      const guarded = guardOutput(answer, { maxChars: 350 });
      if (!guarded.ok) {
        rejected = `guard:${guarded.violations.join(",")}`;
        answer = null;
      } else answer = guarded.text;
    }
    const used = new Set(result?.usedChunkIds ?? []);
    const reason = answer
      ? undefined
      : rejected
        ? "rejected"
        : (result?.failure ?? found?.reason ?? (failed ? "error" : "no_answer"));
    const latencyMs = speculative ? searchMs + answerMs : Date.now() - started;
    return {
      question,
      answer,
      runtimeEvents: [
        {
          type: "retrieval",
          ok: !failed,
          answered: Boolean(answer),
          latencyMs,
          sources: answer ? (result?.answer?.sources.length ?? 0) : 0,
          ...(rejected ? { rejected } : {}),
          query: question,
          ...(found ? { mode: found.mode } : {}),
          speculative,
          ...(answer && result?.answer ? { method: result.answer.method } : {}),
          ...(reason ? { reason } : {}),
          ...(result?.detail ? { detail: result.detail } : {}),
          searchMs,
          answerMs,
          hits: (found?.hits ?? []).slice(0, 8).map((h) => ({
            chunkId: h.chunkId,
            documentId: h.documentId,
            documentTitle: h.documentTitle,
            score: h.score,
            vectorScore: h.vectorScore,
            relevant: h.relevant,
            used: used.has(h.chunkId),
          })),
          ...(answer && result?.answer ? { used: result.answer.sources } : {}),
        },
      ],
      metrics: { retrieveMs: latencyMs },
    };
  };

  const decide = async (s: S): Promise<Partial<S>> => {
    const started = Date.now();
    const first = handleTurn(
      s.session,
      s.config,
      {
        transcript: s.transcript,
        ...(s.confidence !== undefined ? { confidence: s.confidence } : {}),
        understanding: s.understanding,
        llmError: s.llmError,
        answer: s.answer,
      },
      s.ctx,
    );
    const decideMs = Date.now() - started;
    const { output, toolMs, runtimeEvents } = await settleTools(first, s.config, s.ctx);
    return {
      output,
      speech: output.speech,
      engineEvents: output.events,
      runtimeEvents,
      metrics: { decideMs, toolMs },
    };
  };

  const phrase = async (s: S): Promise<Partial<S>> => {
    const draft = s.output!.speech;
    const llm = deps.llm;
    if (!llm || !draft || !s.config.llm.rephrase || s.output!.session.fallbackOnly) return { phrased: false };
    const m = s.metrics;
    const spent = (m.understandMs ?? 0) + (m.retrieveMs ?? 0) + (m.decideMs ?? 0) + (m.toolMs ?? 0);
    const budget = Math.min(s.config.llm.timeoutMs, PHRASE_TIMEOUT_MS, TURN_BUDGET_MS - spent);
    if (budget < MIN_PHRASE_MS) {
      return {
        phrased: false,
        runtimeEvents: [{ type: "phrase_skipped", reason: "latency_budget", spentMs: spent }],
      };
    }
    const { system, user } = phrasePrompt(s.config, s.transcript, draft);
    const r = await llm.generate({
      model: s.config.llm.model,
      system,
      messages: [{ role: "user", content: user }],
      temperature: s.config.llm.temperature,
      timeoutMs: budget,
      jsonSchema: PHRASE_SCHEMA,
    });
    const base = { purpose: "phrase" as const, latencyMs: r.latencyMs, model: r.model };
    if (!r.ok) {
      return {
        phrased: false,
        runtimeEvents: [
          { type: "llm_call", ...base, ok: false, error: r.error, inputTokens: 0, outputTokens: 0 },
        ],
        metrics: { phraseMs: r.latencyMs, llmCalls: 1 },
      };
    }
    const usage = { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens };
    const metrics = { phraseMs: r.latencyMs, llmCalls: 1, ...usage };
    const parsed = LlmPhrase.safeParse(r.json);
    if (!parsed.success)
      return {
        phrased: false,
        runtimeEvents: [{ type: "llm_call", ...base, ...usage, ok: false, error: "schema" }],
        metrics,
      };
    const check = checkPhrase(draft, parsed.data.reply);
    if (!check.ok) {
      return {
        phrased: false,
        runtimeEvents: [
          { type: "llm_call", ...base, ...usage, ok: true },
          { type: "phrase_rejected", reasons: check.reasons },
        ],
        metrics,
      };
    }
    return {
      speech: check.text,
      phrased: true,
      runtimeEvents: [{ type: "llm_call", ...base, ...usage, ok: true }],
      metrics,
    };
  };

  const guard = async (s: S): Promise<Partial<S>> => {
    const g = guardOutput(s.speech, { maxChars: 1200 });
    if (g.ok) return { speech: g.text };
    const fallback = guardOutput(s.output!.speech, { maxChars: 1200 });
    return {
      speech: fallback.ok ? fallback.text : s.config.messages.technicalIssue,
      phrased: false,
      runtimeEvents: [{ type: "guard_blocked", violations: g.violations }],
    };
  };

  const graph = new StateGraph(State)
    .addNode("understand", understand)
    .addNode("retrieve", retrieve)
    .addNode("decide", decide)
    .addNode("phrase", phrase)
    .addNode("guard", guard)
    .addEdge(START, "understand")
    .addConditionalEdges("understand", shouldRetrieve, ["retrieve", "decide"])
    .addEdge("retrieve", "decide")
    .addEdge("decide", "phrase")
    .addEdge("phrase", "guard")
    .addEdge("guard", END)
    .compile();

  /** Run blocking tools until the engine is waiting for the caller again */
  async function settleTools(first: TurnOutput, config: AgentConfig, ctx: EngineContext) {
    let out = first;
    const merged = {
      segments: [...first.segments],
      events: [...first.events],
      background: [...first.backgroundTools],
    };
    const runtimeEvents: RuntimeEvent[] = [];
    let toolMs = 0;
    for (let i = 0; out.awaitingTool && i < 5; i++) {
      const call = out.awaitingTool;
      const started = Date.now();
      let result: ToolResult;
      try {
        result = await withTimeout(deps.tools.run(call, ctx), toolTimeoutMs);
      } catch (err) {
        const timedOut = err instanceof TimeoutError;
        if (timedOut) runtimeEvents.push({ type: "tool_timeout", tool: call.tool });
        result = { ok: false, error: timedOut ? "timeout" : "tool_error" };
      }
      toolMs += Date.now() - started;
      out = resumeAfterTool(out.session, config, result, ctx);
      merged.segments.push(...out.segments);
      merged.events.push(...out.events);
      merged.background.push(...out.backgroundTools);
    }
    const output: TurnOutput = {
      ...out,
      segments: merged.segments,
      speech: merged.segments.map((seg) => seg.text).join(" "),
      events: merged.events,
      backgroundTools: merged.background,
    };
    return { output, toolMs, runtimeEvents };
  }

  return {
    /** Greeting + first question (deterministic, no LLM latency on pickup) */
    async start(config: AgentConfig, ctx: EngineContext, callId: string): Promise<RuntimeTurn> {
      const started = Date.now();
      const { output, toolMs, runtimeEvents } = await settleTools(
        startCall(config, ctx, callId),
        config,
        ctx,
      );
      const g = guardOutput(output.speech, { maxChars: 1200 });
      return {
        output,
        speech: g.ok ? g.text : config.messages.technicalIssue,
        engineEvents: output.events,
        runtimeEvents,
        metrics: { ...emptyMetrics(), totalMs: Date.now() - started, toolMs, deterministic: true },
      };
    },

    /** One caller utterance → what to say and do next */
    async turn(
      config: AgentConfig,
      session: CallSession,
      input: { transcript: string; confidence?: number },
      ctx: EngineContext,
    ): Promise<RuntimeTurn> {
      const started = Date.now();
      const final = await graph.invoke({
        config,
        ctx,
        session,
        transcript: input.transcript,
        confidence: input.confidence,
        understanding: null,
        llmError: false,
        question: null,
        search: null,
        answer: null,
        output: null,
        speech: "",
        phrased: false,
      });
      const m = final.metrics;
      return {
        output: final.output!,
        speech: final.speech,
        engineEvents: final.engineEvents,
        runtimeEvents: final.runtimeEvents,
        metrics: {
          ...emptyMetrics(),
          ...m,
          totalMs: Date.now() - started,
          deterministic: !final.understanding && !final.phrased,
        },
      };
    },
  };
}

export type Runtime = ReturnType<typeof createRuntime>;

function emptyMetrics(): TurnMetrics {
  return {
    totalMs: 0,
    understandMs: 0,
    retrieveMs: 0,
    decideMs: 0,
    toolMs: 0,
    phraseMs: 0,
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    deterministic: true,
  };
}

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
