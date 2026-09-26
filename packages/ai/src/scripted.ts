import type { GenerateParams, LLMProvider, LLMResult } from "./types";

export type ScriptedReply =
  | { json: unknown }
  | { text: string }
  | { error: "timeout" | "rate_limited" | "provider_error" | "invalid_output" | "blocked" | "auth" }
  | ((params: GenerateParams) => ScriptedReply);

/**
 * Deterministic provider for tests and demos: replies are taken from a queue (or a function),
 * and every request is recorded for assertions.
 */
export class ScriptedLLM implements LLMProvider {
  readonly name = "scripted";
  readonly calls: GenerateParams[] = [];

  constructor(private readonly replies: ScriptedReply[] | ((params: GenerateParams) => ScriptedReply)) {}

  async generate(params: GenerateParams): Promise<LLMResult> {
    this.calls.push(params);
    let reply = typeof this.replies === "function" ? this.replies(params) : this.replies.shift();
    while (typeof reply === "function") reply = reply(params);
    const base = { latencyMs: 1, model: params.model };
    if (!reply) return { ok: false, error: "provider_error", message: "No scripted reply left", ...base };
    if ("error" in reply) return { ok: false, error: reply.error, message: reply.error, ...base };
    const usage = { inputTokens: 100, outputTokens: 20 };
    if ("json" in reply)
      return { ok: true, text: JSON.stringify(reply.json), json: reply.json, usage, ...base };
    return { ok: true, text: reply.text, usage, ...base };
  }
}
