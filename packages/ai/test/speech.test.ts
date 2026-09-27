import { describe, expect, it, vi } from "vitest";
import { GeminiSpeech, SpeechError } from "../src";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("GeminiSpeech", () => {
  it("transcribes a voice note with its language, sending the audio inline", async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return json({
        candidates: [
          { content: { parts: [{ text: '{"transcript":"أبي موعد يوم الخميس","language":"AR"}' }] } },
        ],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 12 },
      });
    });
    const speech = new GeminiSpeech("key", { fetch: fetchMock as unknown as typeof fetch });
    const t = await speech.transcribe(Buffer.from("OggS…"), "audio/ogg", { languageHint: "Arabic" });
    expect(t).toEqual({
      text: "أبي موعد يوم الخميس",
      language: "ar",
      usage: { model: "gemini-flash-latest", inputTokens: 120, outputTokens: 12 },
    });
    const parts = (seen[0]!.body.contents as { parts: Record<string, unknown>[] }[])[0]!.parts;
    expect(parts[0]).toEqual({
      inline_data: { mime_type: "audio/ogg", data: Buffer.from("OggS…").toString("base64") },
    });
    expect(String(parts[1]!.text)).toContain("Arabic");
  });

  it("speaks text with the chosen voice and reads the sample rate", async () => {
    const pcm = Buffer.alloc(480);
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Puck");
      expect(body.generationConfig.responseModalities).toEqual(["AUDIO"]);
      return json({
        candidates: [
          {
            content: {
              parts: [
                { inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcm.toString("base64") } },
              ],
            },
          },
        ],
      });
    });
    const out = await new GeminiSpeech("key", { fetch: fetchMock as unknown as typeof fetch }).synthesize(
      "Hello",
      { voice: "Puck" },
    );
    expect(out).toMatchObject({ sampleRate: 24000, model: "gemini-2.5-flash-preview-tts" });
    expect(out.pcm.length).toBe(480);
  });

  it("reports failures by kind", async () => {
    const speech = (status: number) =>
      new GeminiSpeech("key", {
        fetch: (async () => json({ error: {} }, status)) as unknown as typeof fetch,
      });
    await expect(speech(400).transcribe(Buffer.alloc(1), "audio/ogg")).rejects.toMatchObject({
      kind: "unsupported_audio",
    });
    await expect(speech(429).synthesize("x")).rejects.toMatchObject({ kind: "rate_limited" });
    const empty = new GeminiSpeech("key", {
      fetch: (async () => json({ candidates: [] })) as unknown as typeof fetch,
    });
    await expect(empty.synthesize("x")).rejects.toBeInstanceOf(SpeechError);
  });
});
