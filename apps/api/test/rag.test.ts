import { type NestFastifyApplication } from "@nestjs/platform-fastify";
import { HashingEmbeddings } from "@platform/ai";
import { ingestDocument } from "@platform/rag";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../src/infra/prisma.service";
import { StorageService } from "../src/infra/storage.service";
import { TenantDbService } from "../src/infra/tenant-db.service";
import { addMember, createTestApp, hasTestDb, registerOwner } from "./support/app";
import { phoneCall as rawPhoneCall, provisionAgent } from "./support/telephony";

let caller = 0;
/** Each test call from its own number, so the per-caller inbound rate limit never interferes */
const phoneCall = (app: NestFastifyApplication, to: string, lines: string[]) =>
  rawPhoneCall(app, to, lines, undefined, { From: `+9198${String(10_000_000 + caller++).padStart(8, "0")}` });

type Owner = Awaited<ReturnType<typeof registerOwner>>;

const CLINIC_FAQ = `# Parking
Free parking is available in the basement for all patients. The entrance is on Lane 4.

# Insurance
We accept Star Health and HDFC Ergo cashless insurance for all procedures.

# Pricing
A consultation costs 500 rupees. Dental implants start at 25,000 rupees.`;

function multipart(fields: Record<string, string>, name: string, content: string) {
  const boundary = `----rag${randomUUID()}`;
  const parts = Object.entries(fields).map(
    ([k, v]) => `--${boundary}\r\ncontent-disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
  );
  parts.push(
    `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${name}"\r\ncontent-type: text/markdown\r\n\r\n${content}\r\n--${boundary}--\r\n`,
  );
  return {
    body: Buffer.from(parts.join("")),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

describe.skipIf(!hasTestDb)("P10: live-call RAG", () => {
  let app: NestFastifyApplication;
  let owner: Owner;
  let collectionId: string;
  let faqDocId: string;
  const db = () => app.get(TenantDbService).db(owner.me.tenant.id);

  /** What the worker does: extract, chunk and embed (hashing embeddings in tests) */
  const ingest = (documentId: string) =>
    ingestDocument(
      {
        prisma: app.get(PrismaService).client,
        storage: app.get(StorageService).storage,
        embeddings: new HashingEmbeddings(),
        ocr: null,
      },
      { tenantId: owner.me.tenant.id, documentId },
    );

  const upload = async (name: string, content: string) => {
    const m = multipart({ collectionId }, name, content);
    const res = await owner.client.request("POST", "/api/v1/documents", m.body, { headers: m.headers });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };

  const clinicAgent = (collectionIds: string[]) =>
    provisionAgent(app, owner.me.tenant.id, "clinic-reception", {
      workingHours: undefined,
      knowledge: { collectionIds, topK: 4, minScore: 0.55 },
    });

  beforeAll(async () => {
    app = await createTestApp();
    owner = await registerOwner(app, "rag");
    collectionId = (await owner.client.post("/api/v1/knowledge/collections", { name: "Clinic FAQ" })).json()
      .id;
    faqDocId = await upload("clinic-faq.md", CLINIC_FAQ);
    expect(await ingest(faqDocId)).toBe("ready");
  });
  afterAll(() => app.close());

  it("answers a caller's question from the knowledge base and records the source", async () => {
    const clinic = await clinicAgent([collectionId]);
    const call = await phoneCall(app, clinic.e164, ["Is there parking for patients?"]);
    // No LLM in tests: the answer quotes the document, then the workflow continues
    expect(call.last.say).toBe(
      "Free parking is available in the basement for all patients. May I have the patient's name?",
    );

    const record = await db().call.findUniqueOrThrow({
      where: { providerCallSid: call.callSid },
      include: { events: { where: { type: "RAG_RETRIEVAL" } } },
    });
    expect(record.events).toHaveLength(1);
    expect(record.events[0]!.payload).toMatchObject({
      question: "Is there parking for patients?",
      answered: "grounded",
      method: "extractive",
      mode: "hybrid",
      speculative: true,
      used: [{ documentId: faqDocId, title: "clinic faq", headingPath: ["Parking"] }],
    });
    expect((record.events[0]!.payload as { hits: { used: boolean }[] }).hits.some((h) => h.used)).toBe(true);
  });

  it("never guesses: an unknown answer gets the safe reply and becomes a follow-up", async () => {
    const clinic = await clinicAgent([collectionId]);
    const call = await phoneCall(app, clinic.e164, ["Do you offer laser teeth whitening on Sundays?"]);
    expect(call.last.say).toContain("I'll have our team confirm it for you");
    const record = await db().call.findUniqueOrThrow({
      where: { providerCallSid: call.callSid },
      include: { events: { where: { type: "RAG_RETRIEVAL" } } },
    });
    expect(record.events[0]!.payload).toMatchObject({
      answered: "safe",
      reason: expect.stringMatching(/not_relevant|no_hits|weak_match/),
    });
  });

  it("only uses the agent's own collections and documents it may see", async () => {
    const otherCollection = (
      await owner.client.post("/api/v1/knowledge/collections", { name: "Other" })
    ).json().id;
    const noKnowledge = await clinicAgent([otherCollection]);
    expect((await phoneCall(app, noKnowledge.e164, ["Is there parking for patients?"])).last.say).toContain(
      "I'll have our team confirm it",
    );

    // A document restricted to another agent is invisible to this one
    const restricted = await clinicAgent([collectionId]);
    const someoneElse = await clinicAgent([collectionId]);
    await owner.client.patch(`/api/v1/documents/${faqDocId}`, { agentIds: [someoneElse.agentId] });
    expect((await phoneCall(app, restricted.e164, ["Is there parking for patients?"])).last.say).toContain(
      "I'll have our team confirm it",
    );
    expect((await phoneCall(app, someoneElse.e164, ["Is there parking for patients?"])).last.say).toContain(
      "Free parking",
    );
    await owner.client.patch(`/api/v1/documents/${faqDocId}`, { agentIds: [] });
  });

  it("the test console answers from the draft's knowledge too", async () => {
    const agentId = (
      await owner.client.post("/api/v1/agents", { name: "Console", templateKey: "clinic-reception" })
    ).json().id;
    const draft = (await owner.client.get(`/api/v1/agents/${agentId}`)).json().draft.config;
    draft.knowledge.collectionIds = [collectionId];
    draft.workingHours = undefined;
    await owner.client.request("PUT", `/api/v1/agents/${agentId}/draft`, { config: draft });
    const session = (await owner.client.post(`/api/v1/agents/${agentId}/test-sessions`, {})).json();
    const r = (
      await owner.client.post(`/api/v1/test-sessions/${session.sessionId}/messages`, {
        text: "Do you accept insurance?",
      })
    ).json();
    expect(r.reply).toContain("We accept Star Health and HDFC Ergo cashless insurance for all procedures.");
    expect(r.events).toContainEqual(
      expect.objectContaining({
        type: "retrieval",
        answered: true,
        used: [expect.objectContaining({ documentId: faqDocId })],
      }),
    );
  });

  describe("knowledge gaps", () => {
    it("groups unanswered questions, and an FAQ answer closes the gap for the next caller", async () => {
      const clinic = await clinicAgent([collectionId]);
      for (const q of [
        "Do you have wheelchair access?",
        "Is there wheelchair access to the clinic?",
        "Do you offer laser teeth whitening on Sundays?",
      ]) {
        await phoneCall(app, clinic.e164, [q]);
      }
      const gaps = (await owner.client.get("/api/v1/knowledge/gaps?days=7")).json();
      const wheelchair = gaps.items.find((g: { question: string }) => /wheelchair/i.test(g.question));
      expect(wheelchair).toMatchObject({ count: 2 });
      expect(wheelchair.examples).toHaveLength(2);
      expect(gaps.items[0].count).toBeGreaterThanOrEqual(wheelchair.count);

      const faq = await owner.client.post("/api/v1/knowledge/faq", {
        collectionId,
        question: wheelchair.question,
        answer: "Yes, the clinic has a ramp and a wheelchair accessible lift.",
        gapKey: wheelchair.key,
      });
      expect(faq.statusCode, faq.body).toBe(201);
      expect(faq.json()).toMatchObject({ title: expect.stringMatching(/^FAQ: /), status: "PROCESSING" });
      expect(faq.json().storageKey).toBeUndefined();
      expect(await ingest(faq.json().id)).toBe("ready");

      const after = (await owner.client.get("/api/v1/knowledge/gaps?days=7")).json();
      expect(after.items.find((g: { key: string }) => g.key === wheelchair.key)).toBeUndefined();
      const call = await phoneCall(app, clinic.e164, ["Do you have wheelchair access?"]);
      expect(call.last.say).toContain("Yes, the clinic has a ramp and a wheelchair accessible lift.");
    });

    it("needs transcript access to read and knowledge write access to answer", async () => {
      const staff = await addMember(app, owner, "STAFF");
      expect((await staff.client.get("/api/v1/knowledge/gaps")).statusCode).toBe(403);
      const manager = await addMember(app, owner, "MANAGER");
      expect((await manager.client.get("/api/v1/knowledge/gaps")).statusCode).toBe(200);
      expect(
        (
          await manager.client.post("/api/v1/knowledge/faq", {
            collectionId,
            question: "Parking?",
            answer: "Yes.",
          })
        ).statusCode,
      ).toBe(403);
      const outsider = await registerOwner(app, "rag-outsider");
      expect((await outsider.client.get("/api/v1/knowledge/gaps")).json().items).toEqual([]);
    });
  });
});
