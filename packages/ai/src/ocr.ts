import { DEFAULT_GEMINI_MODEL } from "./gemini";
const PAGE_BREAK = "---PAGE---";

/**
 * Text recognition for images and scanned PDFs with Gemini's multimodal input.
 * Returns one string per page; headings are marked with "#" so the chunker keeps sections.
 */
export class GeminiOcr {
  constructor(
    private readonly apiKey: string,
    private readonly model = DEFAULT_GEMINI_MODEL,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://generativelanguage.googleapis.com/v1beta",
  ) {}

  async pages(
    file: Buffer,
    mimeType: string,
    opts: { onUsage?: (u: { model: string; inputTokens: number; outputTokens: number }) => void } = {},
  ): Promise<string[]> {
    const prompt = [
      "Transcribe all text in this document exactly, in reading order.",
      'Mark headings with "#" (Markdown). Write each table row on one line as "Column: value; Column: value".',
      `Put a line containing only ${PAGE_BREAK} between pages. Output only the transcription.`,
    ].join(" ");
    const body = {
      contents: [
        {
          role: "user",
          parts: [{ inline_data: { mime_type: mimeType, data: file.toString("base64") } }, { text: prompt }],
        },
      ],
      generationConfig: { temperature: 0, maxOutputTokens: 8192 },
    };
    const res = await this.fetchImpl(
      `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!res.ok) throw new Error(`OCR failed: HTTP ${res.status}`);
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    opts.onUsage?.({
      model: this.model,
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    });
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    return text
      .split(new RegExp(`^\\s*${PAGE_BREAK}\\s*$`, "m"))
      .map((p) => p.trim())
      .filter(Boolean);
  }
}
