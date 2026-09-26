import type { AgentConfig, Condition, QualificationField, WorkflowStep } from "@platform/shared";
import type { EngineContext } from "./context";
import { extractCandidate, type FieldValue, formatFieldValue, validateFieldValue } from "./fields";
import { detectNotInterested, detectQuestion, detectWantsHuman, parseYesNo } from "./normalisers";
import {
  type CallOutcome,
  type CallSession,
  newSession,
  type QualificationStatus,
  type ToolCall,
  type ToolResult,
} from "./session";
import { renderTemplate, renderToolInput } from "./template";
import { isOpen } from "./working-hours";

export type Intent =
  "answer" | "question" | "both" | "affirm" | "deny" | "wants_human" | "not_interested" | "unclear";

/** What the caller meant: produced by the LLM (primary path) or by keyword rules (fallback path) */
export type Understanding = {
  intent: Intent;
  fields: Record<string, unknown>;
  question?: string | null;
};

export type TurnInput = {
  /** Final transcript of the caller's utterance ("" = silence) */
  transcript: string;
  /** ASR confidence 0–1, when the provider reports it */
  confidence?: number;
  /** LLM understanding; omit to use deterministic rules */
  understanding?: Understanding | null;
  /** The LLM was called for this turn and failed (timeout, provider error, invalid output) */
  llmError?: boolean;
  /** Grounded answer to the caller's question, from the knowledge base (RAG) */
  answer?: string | null;
};

export type SegmentKind = "greeting" | "notice" | "ack" | "answer" | "prompt" | "say" | "goodbye";
export type SpeechSegment = { kind: SegmentKind; text: string };

export type EngineEvent =
  | { type: "step"; stepId: string; stepType: WorkflowStep["type"] }
  | { type: "extraction"; field: string; value: FieldValue; source: "llm" | "rules"; correction: boolean }
  | { type: "validation_error"; field: string; raw: unknown; error: string }
  | { type: "fallback"; reason: "llm_failed" | "llm_unavailable" | "circuit_open" | "silence" | "unclear" }
  | { type: "question"; question: string; answered: "grounded" | "safe" }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; stepId: string; tool: string; ok: boolean; error?: string }
  | { type: "field_skipped"; field: string }
  | { type: "handoff"; reason: string; target: string | null; transferred: boolean }
  | { type: "end"; reason: string; outcome: CallOutcome; qualification: QualificationStatus };

export type TurnOutput = {
  session: CallSession;
  /** Everything to say this turn, in order (deterministic wording; the LLM may rephrase segments) */
  segments: SpeechSegment[];
  speech: string;
  /** The question the caller's next utterance answers */
  prompt: { kind: "field" | "confirm"; fieldKey?: string; text: string } | null;
  backgroundTools: ToolCall[];
  /** Blocking tool the runtime must execute, then call `resumeAfterTool` */
  awaitingTool: ToolCall | null;
  control: "listen" | "await_tool" | "hangup" | "transfer";
  transferTo: string | null;
  events: EngineEvent[];
};

const MAX_HISTORY = 30;
const MAX_PENDING_QUESTIONS = 10;
const BOOKING_TOOLS = new Set(["appointments.create", "calendar.book"]);
const LEAD_TOOLS = new Set(["leads.create", "crm.create_lead"]);

class Turn {
  segments: SpeechSegment[] = [];
  events: EngineEvent[] = [];
  background: ToolCall[] = [];
  awaitingTool: ToolCall | null = null;
  control: TurnOutput["control"] = "listen";
  transferTo: string | null = null;
  prompt: TurnOutput["prompt"] = null;

  say(kind: SegmentKind, text: string): void {
    const t = text.trim();
    if (t) this.segments.push({ kind, text: t });
  }
}

type Ctx = { config: AgentConfig; ctx: EngineContext; s: CallSession; t: Turn };

// ───────────────────────────── public API ─────────────────────────────

/** Begin a call: greeting and the first question */
export function startCall(config: AgentConfig, ctx: EngineContext, callId: string): TurnOutput {
  const c: Ctx = { config, ctx, s: newSession(callId), t: new Turn() };
  const hours = config.workingHours;
  if (hours && !isOpen(hours, ctx.now) && hours.offHours === "closed_message") {
    c.t.say("greeting", renderTemplate(config.greeting, config, {}, ctx));
    c.t.say("notice", render(c, hours.offHoursMessage));
    finish(c, "closed");
    return output(c);
  }
  runSteps(c, { countAttempt: true, failedAnswer: false });
  return output(c);
}

/** Process one caller utterance */
export function handleTurn(
  session: CallSession,
  config: AgentConfig,
  input: TurnInput,
  ctx: EngineContext,
): TurnOutput {
  const c: Ctx = { config, ctx, s: structuredClone(session), t: new Turn() };
  const { s, t } = c;
  if (s.ended) {
    t.control = "hangup";
    return output(c);
  }
  if (s.awaiting?.kind === "tool")
    throw new Error("handleTurn called while a tool result is pending; call resumeAfterTool first");

  s.turns++;
  const text = input.transcript.trim();
  if (text) pushHistory(s, "caller", text);

  // LLM health and the per-call circuit breaker
  if (input.understanding) s.llmFailures = 0;
  else if (input.llmError) {
    s.llmFailures++;
    t.events.push({ type: "fallback", reason: "llm_failed" });
    if (!s.fallbackOnly && s.llmFailures >= config.escalation.maxLlmFailures) {
      s.fallbackOnly = true;
      t.events.push({ type: "fallback", reason: "circuit_open" });
    }
  } else t.events.push({ type: "fallback", reason: "llm_unavailable" });

  if (s.turns > config.limits.maxTurns) {
    t.say("goodbye", render(c, config.messages.goodbye));
    finish(c, "max_turns");
    return output(c);
  }

  // Silence or unusable audio
  if (!text || (input.confidence !== undefined && input.confidence < 0.25)) {
    s.silentTurns++;
    t.events.push({ type: "fallback", reason: "silence" });
    if (s.silentTurns >= config.escalation.maxSilentTurns) {
      t.say("goodbye", render(c, config.messages.noResponse));
      finish(c, "no_response");
    } else {
      t.say("notice", render(c, config.messages.didNotHear));
      repeatPrompt(c);
    }
    return output(c);
  }
  s.silentTurns = 0;

  const understanding = input.understanding
    ? supplementWithRules(c, input.understanding, text)
    : understandWithRules(c, text);
  const source = input.understanding ? "llm" : "rules";
  // Safety net: explicit requests for a person always win, whatever the model said
  const intent: Intent = detectWantsHuman(text) ? "wants_human" : understanding.intent;

  if (intent === "wants_human") {
    requestHandoff(c, "caller_request");
    return output(c);
  }
  if (intent === "not_interested") {
    t.say("goodbye", render(c, config.messages.notInterested));
    finish(c, "not_interested");
    return output(c);
  }

  const changed = mergeFields(c, understanding.fields, source);
  acknowledge(c, changed);

  const isQuestion = intent === "question" || intent === "both";
  if (isQuestion && config.workflow.answerQuestions)
    answerQuestion(c, understanding.question || text, input.answer);

  const awaiting = s.awaiting;
  if (awaiting?.kind === "confirm") {
    const step = stepById(c, awaiting.stepId);
    if (step?.type !== "confirm_and_act")
      throw new Error(`Awaited step ${awaiting.stepId} is not a confirmation`);
    if (intent === "affirm" && !changed.length) {
      s.awaiting = null;
      requestTool(c, step.id, step.action, step.input, false);
      return output(c);
    }
    if (intent === "deny" && !changed.length) {
      t.say("ack", render(c, config.messages.declined));
      for (const key of step.resetOnDecline) {
        delete s.collected[key];
        delete s.attempts[key];
      }
      s.awaiting = null;
      s.stepId = step.onDecline ?? previousCollectStep(c, step.id) ?? step.id;
      runSteps(c, { countAttempt: true, failedAnswer: false });
      return output(c);
    }
    if (!changed.length && !isQuestion) t.say("notice", render(c, config.messages.didNotUnderstand));
    // Details changed or unclear: ask for confirmation again (with the new values)
    s.awaiting = null;
    runSteps(c, { countAttempt: true, failedAnswer: false });
    return output(c);
  }

  const awaitedField = awaiting?.kind === "field" ? awaiting.fieldKey : null;
  const answeredAwaited = awaitedField !== null && changed.some((ch) => ch.key === awaitedField);
  if (!changed.length && !isQuestion) t.events.push({ type: "fallback", reason: "unclear" });
  s.awaiting = null;
  runSteps(c, {
    // A pure question does not use up one of the caller's attempts at the current field
    countAttempt: !(isQuestion && !changed.length),
    failedAnswer: awaitedField !== null && !answeredAwaited && !isQuestion,
  });
  return output(c);
}

/** Continue after the runtime executed a blocking tool */
export function resumeAfterTool(
  session: CallSession,
  config: AgentConfig,
  result: ToolResult,
  ctx: EngineContext,
): TurnOutput {
  const c: Ctx = { config, ctx, s: structuredClone(session), t: new Turn() };
  const { s, t } = c;
  const awaiting = s.awaiting;
  if (awaiting?.kind !== "tool") throw new Error("No tool result is pending");
  const step = stepById(c, awaiting.stepId);
  if (!step || (step.type !== "tool" && step.type !== "confirm_and_act"))
    throw new Error(`Step ${awaiting.stepId} does not run tools`);

  s.toolResults[step.id] = result;
  s.awaiting = null;
  t.events.push({
    type: "tool_result",
    stepId: step.id,
    tool: awaiting.call.tool,
    ok: result.ok,
    ...(result.ok ? {} : { error: result.error }),
  });

  if (result.ok) {
    if (step.type === "confirm_and_act" && step.successMessage) t.say("say", render(c, step.successMessage));
    advance(c, step.id);
  } else {
    t.say("notice", render(c, config.messages.actionFailed));
    if (step.onError) s.stepId = step.onError;
    else advance(c, step.id);
  }
  runSteps(c, { countAttempt: true, failedAnswer: false });
  return output(c);
}

/**
 * The call ended outside the conversation (caller hung up, network drop, max duration):
 * close the session and resolve its outcome from whatever was collected.
 */
export function endCall(
  session: CallSession,
  config: AgentConfig,
  ctx: EngineContext,
  reason: string,
): TurnOutput {
  const c: Ctx = { config, ctx, s: structuredClone(session), t: new Turn() };
  if (!c.s.ended) finish(c, reason);
  c.t.control = "hangup";
  return output(c);
}

// ───────────────────────────── workflow ─────────────────────────────

function runSteps(c: Ctx, opts: { countAttempt: boolean; failedAnswer: boolean }): void {
  const { config, s, t } = c;
  const steps = config.workflow.steps;

  for (let guard = 0; guard < 200; guard++) {
    if (s.ended) return;
    s.stepId ??= steps[0]!.id;
    const step = stepById(c, s.stepId);
    if (!step) {
      finish(c, "workflow_complete");
      return;
    }
    const last = t.events.at(-1);
    if (!(last?.type === "step" && last.stepId === step.id))
      t.events.push({ type: "step", stepId: step.id, stepType: step.type });

    switch (step.type) {
      case "greeting": {
        if (!s.greeted) {
          t.say("greeting", render(c, config.greeting));
          const hours = config.workingHours;
          if (hours && hours.offHours === "take_message" && !isOpen(hours, c.ctx.now))
            t.say("notice", render(c, hours.offHoursMessage));
          s.greeted = true;
        }
        advance(c, step.id);
        continue;
      }
      case "say":
        t.say("say", render(c, step.text));
        advance(c, step.id);
        continue;

      case "collect_fields": {
        const field = step.fields
          .map((k) => fieldByKey(c, k))
          .find(
            (f): f is QualificationField =>
              !!f && s.collected[f.key] === undefined && !s.skipped.includes(f.key),
          );
        if (!field) {
          advance(c, step.id);
          continue;
        }
        const asked = s.attempts[field.key] ?? 0;
        const maxAsks = field.required ? 1 + config.escalation.maxReasksPerField : 1;
        if (asked >= maxAsks) {
          s.skipped.push(field.key);
          t.events.push({ type: "field_skipped", field: field.key });
          if (field.required && config.escalation.onFieldFailure === "handoff") {
            requestHandoff(c, `could_not_capture:${field.key}`);
            return;
          }
          if (field.required && config.escalation.onFieldFailure === "end") {
            t.say("goodbye", render(c, config.messages.technicalIssue));
            finish(c, `could_not_capture:${field.key}`);
            return;
          }
          continue;
        }
        let prompt: string;
        if (asked > 0 && !opts.countAttempt && s.lastPrompt) {
          prompt = s.lastPrompt; // repeat after answering a question, without using up an attempt
        } else {
          const reask = asked > 0 ? field.reaskPrompts[asked - 1] : undefined;
          prompt = asked === 0 ? field.question : (reask ?? field.question);
          if (asked > 0 && opts.failedAnswer && !reask)
            t.say("notice", render(c, config.messages.didNotUnderstand));
          s.attempts[field.key] = asked + 1;
        }
        ask(c, { kind: "field", fieldKey: field.key, prompt: render(c, prompt) });
        return;
      }

      case "tool": {
        if (step.background) {
          const call = makeToolCall(c, step.id, step.tool, step.input, true);
          t.background.push(call);
          s.backgroundTools.push(step.tool);
          t.events.push({ type: "tool_call", call });
          advance(c, step.id);
          continue;
        }
        if (s.toolResults[step.id]) {
          advance(c, step.id);
          continue;
        }
        requestTool(c, step.id, step.tool, step.input, false);
        return;
      }

      case "confirm_and_act": {
        if (s.toolResults[step.id]?.ok) {
          advance(c, step.id);
          continue;
        }
        const prompt = render(c, step.message);
        s.awaiting = { kind: "confirm", stepId: step.id, prompt };
        s.lastPrompt = prompt;
        t.say("prompt", prompt);
        t.prompt = { kind: "confirm", text: prompt };
        return;
      }

      case "branch": {
        const target =
          step.rules.find((r) => r.when.every((cond) => evaluate(cond, s.collected)))?.goto ?? step.otherwise;
        if (target) s.stepId = target;
        else advance(c, step.id);
        continue;
      }

      case "handoff":
        requestHandoff(c, step.reason ?? "workflow");
        return;

      case "end":
        t.say("goodbye", render(c, step.text ?? config.messages.goodbye));
        finish(c, "workflow_complete");
        return;
    }
  }
  // A misconfigured loop (branch → branch …) must never trap a caller
  t.say("goodbye", render(c, config.messages.technicalIssue));
  finish(c, "workflow_loop");
}

function advance(c: Ctx, fromStepId: string): void {
  const steps = c.config.workflow.steps;
  const i = steps.findIndex((s) => s.id === fromStepId);
  c.s.stepId = steps[i + 1]?.id ?? "__end__";
}

function ask(c: Ctx, awaiting: { kind: "field"; fieldKey: string; prompt: string }): void {
  c.s.awaiting = awaiting;
  c.s.lastPrompt = awaiting.prompt;
  c.t.say("prompt", awaiting.prompt);
  c.t.prompt = { kind: "field", fieldKey: awaiting.fieldKey, text: awaiting.prompt };
}

function repeatPrompt(c: Ctx): void {
  const { s, t } = c;
  if (s.lastPrompt && s.awaiting && s.awaiting.kind !== "tool") {
    t.say("prompt", s.lastPrompt);
    t.prompt =
      s.awaiting.kind === "field"
        ? { kind: "field", fieldKey: s.awaiting.fieldKey, text: s.lastPrompt }
        : { kind: "confirm", text: s.lastPrompt };
  }
}

function requestTool(
  c: Ctx,
  stepId: string,
  tool: ToolCall["tool"],
  input: Record<string, string | number | boolean>,
  background: boolean,
): void {
  const call = makeToolCall(c, stepId, tool, input, background);
  c.s.awaiting = { kind: "tool", stepId, call };
  c.t.awaitingTool = call;
  c.t.control = "await_tool";
  c.t.events.push({ type: "tool_call", call });
}

function makeToolCall(
  c: Ctx,
  stepId: string,
  tool: ToolCall["tool"],
  input: Record<string, string | number | boolean>,
  background: boolean,
): ToolCall {
  return {
    tool,
    stepId,
    background,
    input: { ...renderToolInput(input, c.s.collected), collected: { ...c.s.collected } },
    idempotencyKey: `${c.s.callId}:${stepId}:${c.s.turns}`,
  };
}

function requestHandoff(c: Ctx, reason: string): void {
  const { config, s, t } = c;
  const byPolicy = !(reason === "caller_request" && config.escalation.onWantsHuman === "take_message");
  const target =
    config.handoff.enabled && byPolicy && isOpen(config.workingHours, c.ctx.now)
      ? (config.handoff.phoneNumber ?? null)
      : null;
  s.handoff = { requested: true, target, reason };
  t.events.push({ type: "handoff", reason, target, transferred: target !== null });
  if (target) {
    t.say("say", render(c, config.handoff.message));
    t.control = "transfer";
    t.transferTo = target;
    finish(c, "handoff");
  } else {
    t.say("goodbye", render(c, config.handoff.unavailableMessage));
    finish(c, "handoff_unavailable");
  }
}

function finish(c: Ctx, reason: string): void {
  const { s, t } = c;
  s.ended = true;
  s.endReason = reason;
  s.awaiting = null;
  s.qualification = qualification(c);
  s.outcome = outcome(c, reason);
  if (t.control !== "transfer") t.control = "hangup";
  t.events.push({ type: "end", reason, outcome: s.outcome, qualification: s.qualification });
}

// ───────────────────────────── understanding & fields ─────────────────────────────

/** Deterministic understanding for the fallback path: keywords + the field currently being asked */
function understandWithRules(c: Ctx, text: string): Understanding {
  if (detectWantsHuman(text)) return { intent: "wants_human", fields: {} };
  if (detectNotInterested(text)) return { intent: "not_interested", fields: {} };
  const { s } = c;
  const fields: Record<string, unknown> = {};
  const question = detectQuestion(text);

  if (s.awaiting?.kind === "confirm") {
    const step = stepById(c, s.awaiting.stepId);
    const yn = parseYesNo(text);
    // "No, make it 6 pm" → a change to one of the confirmed details
    if (step?.type === "confirm_and_act" && yn !== true) {
      for (const key of step.resetOnDecline) {
        const f = fieldByKey(c, key);
        if (f && f.type !== "text" && f.type !== "name" && validateFieldValue(f, text, c.ctx).ok)
          fields[key] = text;
      }
    }
    if (Object.keys(fields).length) return { intent: "answer", fields };
    if (yn === true) return { intent: "affirm", fields };
    if (yn === false) return { intent: "deny", fields };
    return { intent: question ? "question" : "unclear", fields, question: question ? text : null };
  }

  if (s.awaiting?.kind === "field") {
    const f = fieldByKey(c, s.awaiting.fieldKey);
    const freeText = f?.type === "text" || f?.type === "name";
    if (f && !(question && freeText)) {
      const candidate = extractCandidate(f, text);
      if (candidate !== undefined) fields[f.key] = candidate;
    }
    // Choice fields mentioned out of order ("a villa, within 3 months")
    const step = s.stepId ? stepById(c, s.stepId) : undefined;
    if (step?.type === "collect_fields") {
      for (const key of step.fields) {
        const other = fieldByKey(c, key);
        if (!other || key === f?.key || s.collected[key] !== undefined) continue;
        if (
          other.type === "select" &&
          other.options.some((o) => new RegExp(`\\b${escapeRe(o)}\\b`, "i").test(text))
        )
          fields[key] = text;
      }
    }
  }
  const any = Object.keys(fields).length > 0;
  return {
    intent: question ? (any ? "both" : "question") : any ? "answer" : "unclear",
    fields,
    question: question ? text : null,
  };
}

/**
 * The LLM sometimes misses what the rules can see (e.g. a bare name, a plain "yes").
 * When it reports no value for the awaited field and no stronger intent, let the rules fill the gap.
 */
function supplementWithRules(c: Ctx, llm: Understanding, text: string): Understanding {
  if (llm.intent !== "unclear" && llm.intent !== "answer") return llm;
  const awaiting = c.s.awaiting;
  if (awaiting?.kind === "field" && llm.fields[awaiting.fieldKey] == null) {
    const rules = understandWithRules(c, text);
    const value = rules.fields[awaiting.fieldKey];
    if (value !== undefined && rules.intent !== "question" && rules.intent !== "both") {
      return { ...llm, intent: "answer", fields: { ...llm.fields, [awaiting.fieldKey]: value } };
    }
  }
  if (awaiting?.kind === "confirm" && llm.intent === "unclear" && !Object.keys(llm.fields).length) {
    const rules = understandWithRules(c, text);
    if (rules.intent === "affirm" || rules.intent === "deny" || rules.intent === "answer") return rules;
  }
  return llm;
}

function mergeFields(
  c: Ctx,
  raw: Record<string, unknown>,
  source: "llm" | "rules",
): { key: string; correction: boolean }[] {
  const changed: { key: string; correction: boolean }[] = [];
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value === null || value === undefined || value === "") continue;
    const field = fieldByKey(c, key);
    if (!field) continue; // the model invented a field: ignore it
    const r = validateFieldValue(field, value, c.ctx);
    if (!r.ok) {
      c.t.events.push({ type: "validation_error", field: key, raw: value, error: r.error });
      continue;
    }
    const prev = c.s.collected[key];
    if (prev !== undefined && JSON.stringify(prev) === JSON.stringify(r.value)) continue;
    c.s.collected[key] = r.value;
    c.s.skipped = c.s.skipped.filter((k) => k !== key);
    const correction = prev !== undefined;
    changed.push({ key, correction });
    c.t.events.push({ type: "extraction", field: key, value: r.value, source, correction });
  }
  return changed;
}

function acknowledge(c: Ctx, changed: { key: string; correction: boolean }[]): void {
  for (const ch of changed) {
    const field = fieldByKey(c, ch.key)!;
    const value = formatFieldValue(field, c.s.collected[ch.key]);
    if (ch.correction) c.t.say("ack", `Okay, I've updated the ${field.label.toLowerCase()} to ${value}.`);
    else if (field.confirmBack) c.t.say("ack", `Got it, ${value}.`);
  }
}

function answerQuestion(c: Ctx, question: string, answer: string | null | undefined): void {
  const { s, t } = c;
  if (answer?.trim()) {
    t.say("answer", answer);
    s.answeredQuestions++;
    t.events.push({ type: "question", question, answered: "grounded" });
    return;
  }
  // Never invent business facts: say so and make sure a person follows up
  t.say("answer", render(c, c.config.messages.safeAnswer));
  if (!s.pendingQuestions.includes(question) && s.pendingQuestions.length < MAX_PENDING_QUESTIONS)
    s.pendingQuestions.push(question);
  t.events.push({ type: "question", question, answered: "safe" });
}

function evaluate(cond: Condition, collected: Record<string, FieldValue>): boolean {
  const v = collected[cond.field];
  const eq = (a: unknown, b: unknown) =>
    typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;
  switch (cond.op) {
    case "exists":
      return v !== undefined;
    case "not_exists":
      return v === undefined;
    case "eq":
      return eq(v, cond.value);
    case "neq":
      return v !== undefined && !eq(v, cond.value);
    case "in":
      return Array.isArray(cond.value) && cond.value.some((x) => eq(v, x));
    case "gt":
      return typeof v === "number" && typeof cond.value === "number" && v > cond.value;
    case "gte":
      return typeof v === "number" && typeof cond.value === "number" && v >= cond.value;
    case "lt":
      return typeof v === "number" && typeof cond.value === "number" && v < cond.value;
    case "lte":
      return typeof v === "number" && typeof cond.value === "number" && v <= cond.value;
  }
}

// ───────────────────────────── outcome ─────────────────────────────

function requiredFieldKeys(config: AgentConfig): string[] {
  const inWorkflow = new Set(
    config.workflow.steps.flatMap((s) => (s.type === "collect_fields" ? s.fields : [])),
  );
  return config.qualificationFields.filter((f) => f.required && inWorkflow.has(f.key)).map((f) => f.key);
}

function qualification(c: Ctx): QualificationStatus {
  const collected = Object.keys(c.s.collected);
  if (!collected.length) return "NOT_STARTED";
  // Fields on branches the caller never reached do not count against them
  const visited = requiredFieldKeys(c.config).filter(
    (k) => c.s.attempts[k] !== undefined || c.s.collected[k] !== undefined,
  );
  return visited.every((k) => c.s.collected[k] !== undefined) && visited.length > 0 ? "QUALIFIED" : "PARTIAL";
}

function outcome(c: Ctx, reason: string): CallOutcome {
  const { s, config } = c;
  const stepTool = (stepId: string) => {
    const st = config.workflow.steps.find((x) => x.id === stepId);
    return st?.type === "tool" ? st.tool : st?.type === "confirm_and_act" ? st.action : undefined;
  };
  const okTools = Object.entries(s.toolResults)
    .filter(([, r]) => r.ok)
    .map(([id]) => stepTool(id));
  if (s.handoff.target) return "HUMAN_HANDOFF";
  if (okTools.some((tool) => tool && BOOKING_TOOLS.has(tool))) return "APPOINTMENT_BOOKED";
  if (s.pendingQuestions.length || s.handoff.requested) return "FOLLOW_UP_REQUIRED";
  const leadSaved =
    okTools.some((tool) => tool && LEAD_TOOLS.has(tool)) ||
    s.backgroundTools.some((tool) => LEAD_TOOLS.has(tool));
  if (leadSaved || s.qualification === "QUALIFIED") return "LEAD_CAPTURED";
  if (s.answeredQuestions > 0) return "ENQUIRY_ANSWERED";
  if (reason === "no_response" || reason === "not_interested" || Object.keys(s.collected).length === 0)
    return "ABANDONED";
  return "NONE";
}

// ───────────────────────────── helpers ─────────────────────────────

function output(c: Ctx): TurnOutput {
  // Keep qualification current every turn, so live calls show progress (the outcome is set only at the end)
  if (!c.s.ended) c.s.qualification = qualification(c);
  const speech = c.t.segments.map((seg) => seg.text).join(" ");
  if (speech) pushHistory(c.s, "agent", speech);
  return {
    session: c.s,
    segments: c.t.segments,
    speech,
    prompt: c.t.prompt,
    backgroundTools: c.t.background,
    awaitingTool: c.t.awaitingTool,
    control: c.t.control,
    transferTo: c.t.transferTo,
    events: c.t.events,
  };
}

function pushHistory(s: CallSession, role: "caller" | "agent", text: string): void {
  s.history.push({ role, text });
  if (s.history.length > MAX_HISTORY) s.history.splice(0, s.history.length - MAX_HISTORY);
}

function render(c: Ctx, template: string): string {
  return renderTemplate(template, c.config, c.s.collected, c.ctx);
}

function stepById(c: Ctx, id: string): WorkflowStep | undefined {
  return c.config.workflow.steps.find((s) => s.id === id);
}

function fieldByKey(c: Ctx, key: string): QualificationField | undefined {
  return c.config.qualificationFields.find((f) => f.key === key);
}

function previousCollectStep(c: Ctx, stepId: string): string | undefined {
  const steps = c.config.workflow.steps;
  const i = steps.findIndex((s) => s.id === stepId);
  return steps
    .slice(0, i)
    .reverse()
    .find((s) => s.type === "collect_fields")?.id;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
