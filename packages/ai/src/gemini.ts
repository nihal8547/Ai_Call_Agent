import type {
  EmbeddingProvider,
  EmbeddingResult,
  GenerateParams,
  LLMErrorKind,
  LLMProvider,
  LLMResult,
} from "./types";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Fast, generally available model for live calls (an alias Google keeps current) */
export const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";

/** Models Google no longer serves to new keys; saved configs that name them keep working */
const RETIRED: Record<string, string> = {
  "gemini-1.5-flash": DEFAULT_GEMINI_MODEL,
  "gemini-2.0-flash": DEFAULT_GEMINI_MODEL,
  "gemini-2.5-flash": DEFAULT_GEMINI_MODEL,
  "gemini-2.5-flash-lite": DEFAULT_GEMINI_MODEL,
};

export function resolveGeminiModel(model: string): string {
  return RETIRED[model] ?? model;
}

type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
};

function classify(status: number): LLMErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  return "provider_error";
}

/**
 * Google Gemini via the REST API (no SDK), so requests are explicit and easy to test.
 * JSON mode uses `responseMimeType: application/json` + `responseJsonSchema`.
 */
/** Used for one retry when the chosen model is overloaded (503): lighter, and usually has capacity */
export const GEMINI_OVERLOAD_FALLBACK = "gemini-flash-lite-latest";

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  /** Models that reject `thinkingBudget` (newer models use other thinking settings) */
  private readonly noThinkingBudget = new Set<string>();

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = BASE,
  ) {}

  async generate(p: GenerateParams): Promise<LLMResult> {
    const started = Date.now();
    const first = await this.once(p, resolveGeminiModel(p.model), started);
    if (first.retry === "no_thinking") return (await this.once(p, first.model, started)).result;
    // Overloaded: one try on the lighter model, if the turn still has time for it
    if (
      first.retry === "overloaded" &&
      first.model !== GEMINI_OVERLOAD_FALLBACK &&
      Date.now() - started < p.timeoutMs / 2
    )
      return (await this.once(p, GEMINI_OVERLOAD_FALLBACK, started)).result;
    return first.result;
  }

  private async once(
    p: GenerateParams,
    model: string,
    started: number,
  ): Promise<{ result: LLMResult; model: string; retry?: "no_thinking" | "overloaded" }> {
    const done = (r: Omit<Extract<LLMResult, { ok: false }>, "latencyMs" | "model">) => ({
      result: { ...r, latencyMs: Date.now() - started, model } as LLMResult,
      model,
    });
    const thinking = /flash/.test(model) && !this.noThinkingBudget.has(model);
    const body = {
      systemInstruction: { parts: [{ text: p.system }] },
      contents: p.messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        temperature: p.temperature ?? 0.2,
        maxOutputTokens: p.maxOutputTokens ?? 512,
        ...(p.jsonSchema ? { responseMimeType: "application/json", responseJsonSchema: p.jsonSchema } : {}),
        // Flash models "think" by default, which costs seconds a caller would hear as silence
        ...(thinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    };

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(100, p.timeoutMs - (Date.now() - started))),
      });
    } catch (err) {
      const aborted = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return done({
        ok: false,
        error: aborted ? "timeout" : "provider_error",
        message: (err as Error).message,
      });
    }
    if (!res.ok) {
      if (res.status === 400 && thinking) {
        const detail = await res.text().catch(() => "");
        if (/thinking|invalid argument/i.test(detail)) {
          this.noThinkingBudget.add(model);
          return {
            ...done({ ok: false, error: "provider_error", message: "HTTP 400" }),
            retry: "no_thinking",
          };
        }
      }
      const failed = done({ ok: false, error: classify(res.status), message: `HTTP ${res.status}` });
      return res.status === 503 ? { ...failed, retry: "overloaded" } : failed;
    }

    let data: GeminiResponse;
    try {
      data = (await res.json()) as GeminiResponse;
    } catch {
      return done({ ok: false, error: "invalid_output", message: "Response was not JSON" });
    }
    if (data.promptFeedback?.blockReason)
      return done({ ok: false, error: "blocked", message: data.promptFeedback.blockReason });
    const candidate = data.candidates?.[0];
    if (
      candidate?.finishReason &&
      ["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(candidate.finishReason)
    ) {
      return done({ ok: false, error: "blocked", message: candidate.finishReason });
    }
    const text = candidate?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    if (!text.trim())
      return done({
        ok: false,
        error: "invalid_output",
        message: `Empty response (${candidate?.finishReason ?? "no candidate"})`,
      });

    let json: unknown;
    if (p.jsonSchema) {
      try {
        json = JSON.parse(text);
      } catch {
        return done({ ok: false, error: "invalid_output", message: "Model did not return valid JSON" });
      }
    }
    return {
      model,
      result: {
        ok: true,
        text,
        ...(p.jsonSchema ? { json } : {}),
        usage: {
          inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        },
        latencyMs: Date.now() - started,
        model,
      },
    };
  }
}

/** Gemini text embeddings, truncated to a fixed dimension to match the pgvector column */
export class GeminiEmbeddings implements EmbeddingProvider {
  readonly name = "gemini";

  constructor(
    private readonly apiKey: string,
    readonly model = "gemini-embedding-001",
    readonly dimensions = 768,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = BASE,
  ) {}

  async embed(
    texts: string[],
    opts: { kind: "document" | "query"; timeoutMs?: number },
  ): Promise<EmbeddingResult> {
    if (!texts.length) return { ok: true, vectors: [], usage: { inputTokens: 0 }, model: this.model };
    const body = {
      requests: texts.map((text) => ({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
        taskType: opts.kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
        outputDimensionality: this.dimensions,
      })),
    };
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models/${this.model}:batchEmbedContents`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      if (!res.ok)
        return { ok: false, error: classify(res.status), message: `HTTP ${res.status}`, model: this.model };
      const data = (await res.json()) as { embeddings?: { values?: number[] }[] };
      const vectors = (data.embeddings ?? []).map((e) => normalise(e.values ?? []));
      if (vectors.length !== texts.length || vectors.some((v) => v.length !== this.dimensions)) {
        return {
          ok: false,
          error: "invalid_output",
          message: "Unexpected embedding shape",
          model: this.model,
        };
      }
      // The batch endpoint does not report token usage; estimate for cost tracking
      return {
        ok: true,
        vectors,
        usage: { inputTokens: texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0) },
        model: this.model,
      };
    } catch (err) {
      const aborted = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return {
        ok: false,
        error: aborted ? "timeout" : "provider_error",
        message: (err as Error).message,
        model: this.model,
      };
    }
  }
}

/** Truncated Gemini embeddings are not unit-length; normalise so cosine distance is meaningful */
function normalise(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
