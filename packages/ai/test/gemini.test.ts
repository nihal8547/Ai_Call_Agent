import { describe, expect, it, vi } from "vitest";
import { GeminiEmbeddings, GeminiProvider } from "../src";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const params = {
  model: "gemini-2.5-flash",
  system: "You are a test.",
  messages: [
    { role: "user" as const, content: "hello" },
    { role: "assistant" as const, content: "hi" },
  ],
  timeoutMs: 1000,
  jsonSchema: { type: "object", properties: { intent: { type: "string" } } },
};

describe("GeminiProvider", () => {
  it("sends system instruction, roles, JSON schema and the key header", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      json({
        candidates: [{ content: { parts: [{ text: '{"intent":"answer"}' }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 7 },
      }),
    );
    const r = await new GeminiProvider("k-123", fetchMock as unknown as typeof fetch).generate(params);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      // A retired model name in a saved config is served by the current default
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
    );
    expect((init!.headers as Record<string, string>)["x-goog-api-key"]).toBe("k-123");
    const body = JSON.parse(String(init!.body));
    expect(body.systemInstruction).toEqual({ parts: [{ text: "You are a test." }] });
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model"]);
    expect(body.generationConfig).toMatchObject({
      responseMimeType: "application/json",
      responseJsonSchema: params.jsonSchema,
      // No "thinking" on live calls: it adds seconds of silence
      thinkingConfig: { thinkingBudget: 0 },
    });

    expect(r).toMatchObject({
      ok: true,
      model: "gemini-flash-latest",
      json: { intent: "answer" },
      usage: { inputTokens: 42, outputTokens: 7 },
    });
  });

  it("leaves thinking on for non-flash models", async () => {
    const fetchMock = vi.fn(async () =>
      json({ candidates: [{ content: { parts: [{ text: '{"intent":"x"}' }] } }] }),
    );
    await new GeminiProvider("k", fetchMock as unknown as typeof fetch).generate({
      ...params,
      model: "gemini-pro-latest",
    });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body)).generationConfig.thinkingConfig).toBeUndefined();
  });

  it.each([
    [429, "rate_limited"],
    [403, "auth"],
    [503, "provider_error"],
  ])("maps HTTP %d to %s", async (status, error) => {
    const r = await new GeminiProvider("k", (async () =>
      json({}, status)) as unknown as typeof fetch).generate(params);
    expect(r).toMatchObject({ ok: false, error });
  });

  it("reports safety blocks, empty and non-JSON output as failures", async () => {
    const run = (body: unknown) =>
      new GeminiProvider("k", (async () => json(body)) as unknown as typeof fetch).generate(params);
    await expect(run({ candidates: [{ finishReason: "SAFETY" }] })).resolves.toMatchObject({
      ok: false,
      error: "blocked",
    });
    await expect(run({ promptFeedback: { blockReason: "OTHER" } })).resolves.toMatchObject({
      ok: false,
      error: "blocked",
    });
    await expect(
      run({ candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "MAX_TOKENS" }] }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_output" });
    await expect(
      run({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_output" });
  });

  it("times out instead of hanging the call", async () => {
    const slow = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
      )) as unknown as typeof fetch;
    const r = await new GeminiProvider("k", slow).generate({ ...params, timeoutMs: 50 });
    expect(r).toMatchObject({ ok: false, error: "timeout" });
    expect(r.latencyMs).toBeLessThan(1000);
  });
});

describe("GeminiEmbeddings", () => {
  it("batches texts with task type and dimension, returns unit vectors", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      json({ embeddings: [{ values: [3, 4, ...Array(766).fill(0)] }, { values: Array(768).fill(1) }] }),
    );
    const e = new GeminiEmbeddings("k", "gemini-embedding-001", 768, fetchMock as unknown as typeof fetch);
    const r = await e.embed(["a", "b"], { kind: "query" });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.requests[0]).toMatchObject({
      taskType: "RETRIEVAL_QUERY",
      outputDimensionality: 768,
      model: "models/gemini-embedding-001",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.vectors[0]!.slice(0, 2)).toEqual([0.6, 0.8]);
      expect(Math.hypot(...r.vectors[1]!)).toBeCloseTo(1, 6);
    }
  });

  it("rejects vectors of the wrong size", async () => {
    const e = new GeminiEmbeddings("k", "m", 768, (async () =>
      json({ embeddings: [{ values: [1, 2] }] })) as unknown as typeof fetch);
    await expect(e.embed(["a"], { kind: "document" })).resolves.toMatchObject({
      ok: false,
      error: "invalid_output",
    });
  });
});
