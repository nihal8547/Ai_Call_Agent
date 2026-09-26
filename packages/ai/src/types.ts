export type ChatMessage = { role: "user" | "assistant"; content: string };

export type GenerateParams = {
  model: string;
  system: string;
  messages: ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs: number;
  /** When set, the provider must return JSON matching this JSON Schema */
  jsonSchema?: Record<string, unknown>;
};

export type Usage = { inputTokens: number; outputTokens: number };

export type LLMErrorKind =
  "timeout" | "rate_limited" | "provider_error" | "invalid_output" | "blocked" | "auth";

/** Providers never throw into the conversation: every failure is a typed result */
export type LLMResult =
  | { ok: true; text: string; json?: unknown; usage: Usage; latencyMs: number; model: string }
  | { ok: false; error: LLMErrorKind; message: string; latencyMs: number; model: string };

export interface LLMProvider {
  readonly name: string;
  generate(params: GenerateParams): Promise<LLMResult>;
}

export type EmbeddingResult =
  | { ok: true; vectors: number[][]; usage: { inputTokens: number }; model: string }
  | { ok: false; error: LLMErrorKind; message: string; model: string };

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], opts: { kind: "document" | "query"; timeoutMs?: number }): Promise<EmbeddingResult>;
}
