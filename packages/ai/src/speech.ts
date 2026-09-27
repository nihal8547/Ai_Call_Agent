import { DEFAULT_GEMINI_MODEL } from "./gemini";

/** Gemini's text-to-speech model (a preview name today; configurable so it can follow Google's naming) */
export const DEFAULT_GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";

/** Prebuilt Gemini voices offered to businesses; all of them speak Arabic, English and Indian languages */
export const TTS_VOICES = [
  { id: "Kore", label: "Kore: female, clear" },
  { id: "Aoede", label: "Aoede: female, relaxed" },
  { id: "Puck", label: "Puck: male, upbeat" },
  { id: "Charon", label: "Charon: male, calm" },
] as const;
export type TtsVoice = (typeof TTS_VOICES)[number]["id"];

export type SpeechErrorKind =
  "auth" | "rate_limited" | "unsupported_audio" | "timeout" | "provider_error" | "empty";

export class SpeechError extends Error {
  override readonly name = "SpeechError";
  constructor(
    readonly kind: SpeechErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export type Transcript = {
  text: string;
  /** Language spoken, as a short code ("ar", "en", "ml", "hi"), when the model could tell */
  language: string | null;
  usage: { model: string; inputTokens: number; outputTokens: number };
};

type GeminiAudioResponse = {
  candidates?: {
    content?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] };
    finishReason?: string;
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
};

/**
 * Speech with Gemini: transcribing customers' voice notes and speaking the agent's replies. Both
 * use the same API key as the rest of the platform's AI.
 */
export class GeminiSpeech {
  constructor(
    private readonly apiKey: string,
    private readonly opts: {
      model?: string;
      ttsModel?: string;
      fetch?: typeof fetch;
      baseUrl?: string;
    } = {},
  ) {}

  private get base() {
    return this.opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  }

  private async call(model: string, body: unknown, timeoutMs: number): Promise<GeminiAudioResponse> {
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(
        `${this.base}/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new SpeechError(
        timedOut ? "timeout" : "provider_error",
        timedOut ? "Gemini did not answer in time" : "Could not reach Gemini",
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const kind: SpeechErrorKind =
        res.status === 401 || res.status === 403
          ? "auth"
          : res.status === 429
            ? "rate_limited"
            : res.status === 400
              ? "unsupported_audio"
              : "provider_error";
      throw new SpeechError(
        kind,
        `Gemini returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
    }
    return (await res.json()) as GeminiAudioResponse;
  }

  /** A voice note → its words, in the language spoken */
  async transcribe(
    audio: Buffer,
    mimeType: string,
    o: { languageHint?: string; timeoutMs?: number } = {},
  ): Promise<Transcript> {
    const model = this.opts.model ?? DEFAULT_GEMINI_MODEL;
    const prompt = [
      "Transcribe this voice message from a customer exactly, word for word, in the language spoken.",
      "Arabic in Arabic script (Gulf dialect as spoken, not translated); other languages in their own script.",
      "Keep numbers as the speaker said them, written as digits. Do not answer or summarise the message.",
      o.languageHint
        ? `The business mostly hears ${o.languageHint}, but the customer may use another language.`
        : "",
      'Return JSON: {"transcript": "...", "language": "short language code, e.g. ar, en, ml, hi"}. Empty transcript if nothing is said.',
    ]
      .filter(Boolean)
      .join(" ");
    const flash = /flash/.test(model);
    const data = await this.call(
      model,
      {
        contents: [
          {
            role: "user",
            parts: [
              { inline_data: { mime_type: mimeType, data: audio.toString("base64") } },
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 2048,
          responseMimeType: "application/json",
          responseJsonSchema: {
            type: "object",
            properties: { transcript: { type: "string" }, language: { type: "string" } },
            required: ["transcript"],
          },
          ...(flash ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      },
      o.timeoutMs ?? 30_000,
    );
    const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    let parsed: { transcript?: string; language?: string };
    try {
      parsed = JSON.parse(raw) as { transcript?: string; language?: string };
    } catch {
      throw new SpeechError("provider_error", "Gemini did not return a transcript");
    }
    return {
      text: (parsed.transcript ?? "").trim(),
      language: parsed.language?.trim().toLowerCase().slice(0, 10) || null,
      usage: {
        model,
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }

  /** Text → mono 16-bit PCM (Gemini speaks at 24 kHz) */
  async synthesize(
    text: string,
    o: { voice?: string; timeoutMs?: number } = {},
  ): Promise<{ pcm: Buffer; sampleRate: number; model: string }> {
    const model = this.opts.ttsModel ?? DEFAULT_GEMINI_TTS_MODEL;
    const data = await this.call(
      model,
      {
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: o.voice ?? "Kore" } } },
        },
      },
      o.timeoutMs ?? 30_000,
    );
    const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part?.inlineData?.data) throw new SpeechError("empty", "Gemini returned no audio");
    const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1] ?? 24_000);
    return { pcm: Buffer.from(part.inlineData.data, "base64"), sampleRate: rate, model };
  }
}
