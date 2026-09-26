import { describe, expect, it, vi } from "vitest";
import { GeminiOcr, HashingEmbeddings } from "../src";

const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

describe("HashingEmbeddings", () => {
  it("is deterministic, unit length, and ranks shared words higher", async () => {
    const e = new HashingEmbeddings();
    const r = await e.embed([
      "Free parking in the basement",
      "free parking available",
      "Implants start at 25,000 rupees",
    ]);
    if (!r.ok) throw new Error("embed failed");
    const [a, b, c] = r.vectors as [number[], number[], number[]];
    expect(a).toHaveLength(768);
    expect(Math.hypot(...a)).toBeCloseTo(1, 6);
    expect(cos(a, b)).toBeGreaterThan(cos(a, c));
    const again = await e.embed(["Free parking in the basement"]);
    expect(again.ok && again.vectors[0]).toEqual(a);
  });
});

describe("GeminiOcr", () => {
  it("sends the file inline and splits pages", async () => {
    const fetchMock = vi.fn(
      async (_u: string | URL | Request, _i?: RequestInit) =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "# Menu\nTea 20\n---PAGE---\nCoffee 30" }] } }],
          }),
        ),
    );
    const pages = await new GeminiOcr("k", "gemini-2.5-flash", fetchMock as unknown as typeof fetch).pages(
      Buffer.from("img"),
      "image/png",
    );
    expect(pages).toEqual(["# Menu\nTea 20", "Coffee 30"]);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.contents[0].parts[0].inline_data).toEqual({
      mime_type: "image/png",
      data: Buffer.from("img").toString("base64"),
    });
  });
});
