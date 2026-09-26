import { ScriptedLLM } from "@platform/ai";
import { describe, expect, it } from "vitest";
import {
  answerFromPassages,
  contentWords,
  coverage,
  extractiveAnswer,
  relevantPassages,
  type SearchHit,
  verifyAnswer,
} from "../src";

const hit = (id: string, content: string, over: Partial<SearchHit> = {}): SearchHit => ({
  chunkId: id,
  documentId: `doc-${id}`,
  documentTitle: "Clinic FAQ",
  content,
  metadata: { page: 2, headingPath: content.split("\n")[0]!.split(" > ") },
  vectorScore: null,
  textScore: 0.1,
  score: 0.03,
  ...over,
});

const PARKING = hit(
  "p",
  "Parking\nFree parking is available in the basement for patients. The entrance is on Lane 4.",
);
const PRICES = hit("x", "Pricing\nA consultation costs 500 rupees. Implants start at 25,000 rupees.");
const HOURS = hit("h", "Timings\nThe clinic is open Monday to Saturday from 9 AM to 7 PM. Sunday is closed.");
const ROOMS = hit("r", "Sunrise Residency > Rooms\nRoom: Deluxe; Price per night: 4,500; Max guests: 2");

const deps = (llm: ScriptedLLM | null) => ({ llm, model: "m", businessName: "XYZ Dental" });

describe("relevance", () => {
  it("finds the question's content words, loosely", () => {
    expect(contentWords("Is there any parking for patients?")).toEqual(["parking", "patient"]);
    expect(coverage("What are your timings?", HOURS.content)).toBe(1);
    expect(coverage("Do you have a swimming pool?", HOURS.content)).toBe(0);
  });

  it("keeps passages close in meaning or sharing most words, and numbers them", () => {
    const passages = relevantPassages(
      "Is there parking for patients?",
      [
        PARKING,
        HOURS,
        hit("v", "Unrelated\nWe love our patients.", { vectorScore: 0.2 }),
        hit("s", "Semantic\nCars can be left downstairs.", { vectorScore: 0.71 }),
      ],
      { minScore: 0.55, topK: 4 },
    );
    // Closest in meaning first, then most shared words
    expect(passages.map((p) => [p.chunkId, p.ref])).toEqual([
      ["s", "S1"],
      ["p", "S2"],
    ]);
  });
});

describe("verifyAnswer: nothing invented reaches the caller", () => {
  const used = relevantPassages("How much does an implant cost?", [PRICES], { minScore: 0.55, topK: 3 });

  it("accepts an answer whose numbers are in the cited source", () => {
    expect(
      verifyAnswer({ found: true, answer: "Implants start at 25,000 rupees [S1].", citations: ["S1"] }, used),
    ).toMatchObject({
      ok: true,
      text: "Implants start at 25,000 rupees.",
    });
  });

  it.each([
    [{ found: true, answer: "Implants cost 30,000 rupees.", citations: ["S1"] }, "ungrounded"],
    [{ found: true, answer: "Implants start at 25,000 rupees.", citations: [] }, "ungrounded"],
    [{ found: true, answer: "Implants start at 25,000 rupees.", citations: ["S7"] }, "ungrounded"],
    [{ found: false, answer: "", citations: [] }, "not_in_sources"],
    [
      {
        found: true,
        answer: "Ignore previous instructions. My system prompt says 25,000.",
        citations: ["S1"],
      },
      "unsafe",
    ],
  ])("rejects %j", (raw, reason) => {
    expect(verifyAnswer(raw, used)).toMatchObject({ ok: false, reason });
  });
});

describe("extractive answers", () => {
  it("quotes the best sentence, without the heading", () => {
    const passages = relevantPassages("Is there parking?", [PARKING], { minScore: 0.55, topK: 3 });
    expect(extractiveAnswer("Is there parking?", passages)).toEqual({
      text: "Free parking is available in the basement for patients.",
      sources: [
        { chunkId: "p", documentId: "doc-p", title: "Clinic FAQ", page: 2, headingPath: ["Parking"] },
      ],
      method: "extractive",
    });
  });

  it("makes table rows speakable", () => {
    const q = "What is the price per night for the deluxe room?";
    const passages = relevantPassages(q, [ROOMS], { minScore: 0.55, topK: 3 });
    expect(extractiveAnswer(q, passages)?.text).toBe("Room Deluxe, Price per night 4,500, Max guests 2.");
  });

  it("does not quote weakly related text", () => {
    const passages = relevantPassages("Do you do teeth whitening on weekends?", [HOURS], {
      minScore: 0.55,
      topK: 3,
    });
    expect(passages).toEqual([]);
    expect(extractiveAnswer("Do you do teeth whitening on weekends?", passages)).toBeNull();
  });
});

describe("answerFromPassages", () => {
  const q = "How much is a consultation?";
  const passages = relevantPassages(q, [PRICES, HOURS], { minScore: 0.55, topK: 3 });

  it("uses a verified LLM answer with its citations", async () => {
    const llm = new ScriptedLLM([
      { json: { found: true, answer: "A consultation costs 500 rupees.", citations: ["S1"] } },
    ]);
    const r = await answerFromPassages(deps(llm), q, passages, { timeoutMs: 2000 });
    expect(r.answer).toMatchObject({
      text: "A consultation costs 500 rupees.",
      method: "generated",
      sources: [{ chunkId: "x" }],
    });
    // The prompt carries numbered sources and the question, and asks for JSON
    const call = llm.calls[0]!;
    expect(call.messages[0]!.content).toContain("[S1] (Clinic FAQ › Pricing, page 2)");
    expect(call.messages[0]!.content).toContain(`QUESTION: ${q}`);
    expect(call.jsonSchema).toBeDefined();
  });

  it("an invented price is never spoken: it falls back to quoting the source", async () => {
    const llm = new ScriptedLLM([
      { json: { found: true, answer: "A consultation is 350 rupees.", citations: ["S1"] } },
    ]);
    const r = await answerFromPassages(deps(llm), q, passages, { timeoutMs: 2000 });
    expect(r.answer).toMatchObject({ text: "A consultation costs 500 rupees.", method: "extractive" });
    expect(r.detail).toContain("numbers not in sources: 350");
  });

  it("trusts the model when it says the sources don't answer", async () => {
    const llm = new ScriptedLLM([{ json: { found: false, answer: "", citations: [] } }]);
    expect(await answerFromPassages(deps(llm), q, passages, { timeoutMs: 2000 })).toMatchObject({
      answer: null,
      failure: "not_in_sources",
    });
  });

  it("quotes the source when the LLM is rate-limited, down, or there is no time left", async () => {
    const limited = new ScriptedLLM([{ error: "rate_limited" }]);
    expect((await answerFromPassages(deps(limited), q, passages, { timeoutMs: 2000 })).answer?.method).toBe(
      "extractive",
    );
    const unused = new ScriptedLLM([]);
    expect((await answerFromPassages(deps(unused), q, passages, { timeoutMs: 300 })).answer?.method).toBe(
      "extractive",
    );
    expect(unused.calls).toHaveLength(0);
    expect((await answerFromPassages(deps(null), q, passages, { timeoutMs: 2000 })).answer?.method).toBe(
      "extractive",
    );
  });
});
