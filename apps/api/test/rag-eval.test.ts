import { type NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  type EmbeddingProvider,
  GeminiEmbeddings,
  HashingEmbeddings,
  ScriptedLLM,
  type LLMProvider,
} from "@platform/ai";
import { unsupportedNumbers } from "@platform/core";
import { createKnowledgeRetriever, ingestDocument } from "@platform/rag";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../src/infra/prisma.service";
import { StorageService } from "../src/infra/storage.service";
import { createTestApp, hasTestDb, registerOwner } from "./support/app";
import { provisionAgent } from "./support/telephony";

const EVAL_DIR = path.resolve(__dirname, "../../../packages/rag/eval");
const TEMPLATES = [
  "clinic-reception",
  "real-estate-ava",
  "hotel-reservations",
  "restaurant-booking",
] as const;
type EvalSet = { answerable: { q: string; expect: string }[]; unanswerable: string[] };
/**
 * EVAL_EMBEDDINGS=gemini runs the production configuration (needs GEMINI_API_KEY, uses quota);
 * the default is offline hashing embeddings, where retrieval is keyword-driven.
 */
const GEMINI = process.env.EVAL_EMBEDDINGS === "gemini" && Boolean(process.env.GEMINI_API_KEY);
/** Offline, keywords must carry retrieval: a regression floor. With real embeddings: the target. */
const MIN_HIT_RATE = GEMINI ? 0.9 : 0.7;

/** Paced so the free-tier per-minute quota is not exhausted */
function pacedEmbeddings(): EmbeddingProvider {
  if (!GEMINI) return new HashingEmbeddings();
  const inner = new GeminiEmbeddings(process.env.GEMINI_API_KEY!);
  let last = 0;
  return {
    name: inner.name,
    model: inner.model,
    dimensions: inner.dimensions,
    embed: async (texts, opts) => {
      const wait = last + 700 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return inner.embed(texts, { ...opts, timeoutMs: 15_000 });
    },
  } as EmbeddingProvider;
}
const embeddings = pacedEmbeddings();

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * Retrieval and grounding quality per template, on the real stack (Postgres full-text + pgvector
 * with offline hashing embeddings, no LLM unless stated). Run with REPORT=1 to print the numbers.
 */
describe.skipIf(!hasTestDb)(`RAG evaluation (${GEMINI ? "Gemini embeddings" : "offline"})`, () => {
  let app: NestFastifyApplication;
  const setups = new Map<
    string,
    { tenantId: string; agentId: string; collectionId: string; doc: string; set: EvalSet; business: string }
  >();
  const report: Record<string, unknown>[] = [];
  const timeout = GEMINI ? 600_000 : 30_000;

  beforeAll(async () => {
    app = await createTestApp();
    const owner = await registerOwner(app, "rag-eval");
    const tenantId = owner.me.tenant.id;
    for (const t of TEMPLATES) {
      const doc = readFileSync(path.join(EVAL_DIR, `${t}.md`), "utf8");
      const set = JSON.parse(readFileSync(path.join(EVAL_DIR, `${t}.json`), "utf8")) as EvalSet;
      const collectionId = (
        await owner.client.post("/api/v1/knowledge/collections", { name: `Eval ${t}` })
      ).json().id;
      const boundary = `----eval${randomUUID()}`;
      const body = Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="collectionId"\r\n\r\n${collectionId}\r\n` +
          `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${t}.md"\r\ncontent-type: text/markdown\r\n\r\n${doc}\r\n--${boundary}--\r\n`,
      );
      const res = await owner.client.request("POST", "/api/v1/documents", body, {
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      });
      expect(res.statusCode, res.body).toBe(201);
      const r = await ingestDocument(
        {
          prisma: app.get(PrismaService).client,
          storage: app.get(StorageService).storage,
          embeddings,
          ocr: null,
        },
        { tenantId, documentId: res.json().id },
      );
      expect(r).toBe("ready");
      const agent = await provisionAgent(app, tenantId, t, {
        knowledge: { collectionIds: [collectionId], topK: 4, minScore: 0.55 },
      });
      setups.set(t, {
        tenantId,
        agentId: agent.agentId,
        collectionId,
        doc,
        set,
        business: agent.config.businessName,
      });
    }
  }, timeout);
  afterAll(async () => {
    // eslint-disable-next-line no-console -- the report is the point of REPORT=1 / DEBUG_EVAL
    if (process.env.REPORT) console.table(report);
    await app.close();
  });

  const retriever = (t: string, llm: LLMProvider | null = null) => {
    const s = setups.get(t)!;
    return createKnowledgeRetriever({
      prisma: app.get(PrismaService).client,
      embeddings,
      llm,
      tenantId: s.tenantId,
      agentId: s.agentId,
      businessName: s.business,
      model: "eval",
      knowledge: { collectionIds: [s.collectionId], topK: 4, minScore: 0.55 },
    });
  };

  it.each(TEMPLATES)(
    "%s: finds the right passage for ≥ 90%% of real questions, and answers none it can't",
    async (t) => {
      const { set, doc } = setups.get(t)!;
      const r = retriever(t);
      let hits = 0;
      let answered = 0;
      let correct = 0;
      const misses: string[] = [];
      const latencies: number[] = [];
      for (const { q, expect: want } of set.answerable) {
        const found = await r.search(q, { timeoutMs: 900 });
        latencies.push(found.latencyMs);
        const hit = (found.passages as { content: string }[]).some((p) =>
          norm(p.content).includes(norm(want)),
        );
        if (hit) hits++;
        else {
          misses.push(q);
          if (process.env.DEBUG_EVAL) {
            const ps = found.passages as { content: string; coverage: number }[];
            // eslint-disable-next-line no-console -- the report is the point of REPORT=1 / DEBUG_EVAL
            console.log(
              `MISS ${q} || ${ps.map((p) => `[${p.coverage.toFixed(2)}] ${p.content.split("\n")[0]}`).join(" | ")}`,
            );
          }
        }
        const a = await r.answer(q, found, { timeoutMs: 0 });
        if (a.answer) {
          answered++;
          if (
            norm(a.answer.text).includes(norm(want)) ||
            norm(want).includes(norm(a.answer.text).replace(/ $/, ""))
          )
            correct++;
          // Every number spoken is in the business's own document
          expect(unsupportedNumbers(a.answer.text, [doc]), `${q} → ${a.answer.text}`).toEqual([]);
        }
      }
      let invented = 0;
      const wrongly: string[] = [];
      for (const q of set.unanswerable) {
        const a = await r.answer(q, await r.search(q, { timeoutMs: 900 }), { timeoutMs: 0 });
        if (a.answer) {
          invented++;
          wrongly.push(`${q} → ${a.answer.text}`);
        }
      }
      latencies.sort((a, b) => a - b);
      const hitRate = hits / set.answerable.length;
      report.push({
        template: t,
        questions: set.answerable.length,
        hitRate: `${Math.round(hitRate * 100)}%`,
        answered: `${Math.round((answered / set.answerable.length) * 100)}%`,
        answeredCorrectly: `${Math.round((correct / Math.max(1, answered)) * 100)}%`,
        unanswerableAnswered: `${invented}/${set.unanswerable.length}`,
        searchP95ms: latencies[Math.floor(latencies.length * 0.95)],
        misses: misses.join(" | "),
      });
      expect(hitRate, `missed: ${misses.join(" | ")}`).toBeGreaterThanOrEqual(MIN_HIT_RATE);
      expect(wrongly).toEqual([]);
    },
    timeout,
  );

  it(
    "an LLM that invents facts never gets them spoken",
    async () => {
      // Every "answer" claims a price that is in no document, and cites the first source
      const liar = new ScriptedLLM(() => ({
        json: { found: true, answer: "That costs 99,999 rupees and is open 24/7.", citations: ["S1"] },
      }));
      for (const t of TEMPLATES) {
        const { set, doc } = setups.get(t)!;
        const r = retriever(t, liar);
        for (const q of [...set.answerable.map((a) => a.q), ...set.unanswerable]) {
          const a = await r.answer(q, await r.search(q, { timeoutMs: 900 }), { timeoutMs: 2000 });
          if (a.answer) {
            expect(a.answer.method, q).toBe("extractive"); // the lie was rejected; only a quote remains
            expect(unsupportedNumbers(a.answer.text, [doc]), q).toEqual([]);
          }
        }
      }
    },
    timeout,
  );
});
