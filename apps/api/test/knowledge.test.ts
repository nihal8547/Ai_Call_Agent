import { type NestFastifyApplication } from "@nestjs/platform-fastify";
import { HashingEmbeddings } from "@platform/ai";
import { ingestDocument } from "@platform/rag";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../src/infra/prisma.service";
import { QueueService } from "../src/infra/queue.service";
import { StorageService } from "../src/infra/storage.service";
import { TenantDbService } from "../src/infra/tenant-db.service";
import { addMember, type Client, createTestApp, hasTestDb, registerOwner } from "./support/app";

type Owner = Awaited<ReturnType<typeof registerOwner>>;

/** Build a multipart/form-data body the way a browser would */
function multipart(fields: Record<string, string>, file?: { name: string; content: Buffer | string }) {
  const boundary = `----test${randomUUID()}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${file.name}"\r\ncontent-type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content),
      Buffer.from("\r\n"),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

const FAQ = `# Parking and timings

The clinic is open Monday to Saturday from 9 AM to 7 PM. Sunday is closed.

Free basement parking is available for all patients.

# Pricing

A consultation costs 500 rupees. Dental implants start at 25,000 rupees.`;

describe.skipIf(!hasTestDb)("knowledge base: collections, documents, ingestion and search", () => {
  let app: NestFastifyApplication;
  let owner: Owner;
  let collectionId: string;

  beforeAll(async () => {
    app = await createTestApp();
    owner = await registerOwner(app, "knowledge");
    const res = await owner.client.post("/api/v1/knowledge/collections", { name: "Clinic FAQ" });
    expect(res.statusCode).toBe(201);
    collectionId = res.json().id;
  });
  afterAll(() => app.close());

  const upload = (
    client: Client,
    name: string,
    content: Buffer | string,
    fields: Record<string, string> = { collectionId },
  ) => {
    const m = multipart(fields, { name, content });
    return client.request("POST", "/api/v1/documents", m.body, { headers: m.headers });
  };

  /** What the worker does, run inline with local storage and hashing embeddings */
  const ingest = (tenantId: string, documentId: string) =>
    ingestDocument(
      {
        prisma: app.get(PrismaService).client,
        storage: app.get(StorageService).storage,
        embeddings: new HashingEmbeddings(),
        ocr: null,
      },
      { tenantId, documentId },
    );

  const search = (client: Client, body: Record<string, unknown>) =>
    client.post("/api/v1/knowledge/search", body);

  it("uploads, queues, ingests and finds a document by meaning and keywords", async () => {
    const res = await upload(owner.client, "clinic-faq.md", FAQ);
    expect(res.statusCode).toBe(201);
    const doc = res.json();
    expect(doc).toMatchObject({
      status: "PROCESSING",
      title: "clinic faq",
      mimeType: "text/markdown",
      version: 1,
    });

    const job = await app.get(QueueService).ingestion.getJob(`${doc.id}-v1`);
    expect(job?.data).toEqual({ tenantId: owner.me.tenant.id, documentId: doc.id });

    expect(await ingest(owner.me.tenant.id, doc.id)).toBe("ready");
    const detail = (await owner.client.get(`/api/v1/documents/${doc.id}`)).json();
    expect(detail).toMatchObject({ status: "READY", progress: 100 });
    expect(detail.chunkCount).toBeGreaterThan(0);
    expect(detail.preview[0].content).toContain("Parking");

    const hits = (await search(owner.client, { query: "Is there parking?" })).json();
    expect(hits.mode).toBe("hybrid");
    expect(hits.hits[0]).toMatchObject({ documentId: doc.id, documentTitle: "clinic faq" });
    expect(hits.hits[0].content).toContain("parking");

    const download = await owner.client.get(`/api/v1/documents/${doc.id}/download`);
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toBe('attachment; filename="clinic-faq.md"');
    expect(download.body).toBe(FAQ);
  });

  it("rejects duplicates, unsupported files, empty files and unknown collections", async () => {
    expect((await upload(owner.client, "again.md", FAQ)).statusCode).toBe(409);
    const exe = await upload(
      owner.client,
      "brochure.pdf",
      Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]),
    );
    expect(exe.statusCode).toBe(415);
    expect((await upload(owner.client, "empty.txt", "")).statusCode).toBe(400);
    const unknown = await upload(owner.client, "x.txt", "Some text here", { collectionId: randomUUID() });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().errors[0].path).toBe("collectionId");
    const noFile = multipart({ collectionId });
    expect(
      (await owner.client.request("POST", "/api/v1/documents", noFile.body, { headers: noFile.headers }))
        .statusCode,
    ).toBe(400);
    expect((await owner.client.post("/api/v1/documents", { collectionId })).statusCode).toBe(415);
  });

  it("enforces plan limits", async () => {
    const other = await registerOwner(app, "knowledge-limits");
    const tenantId = other.me.tenant.id;
    const cid = (await other.client.post("/api/v1/knowledge/collections", { name: "Docs" })).json().id;
    const db = app.get(TenantDbService).db(tenantId);
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    await db.tenant.update({
      where: { id: tenantId },
      data: { usageLimits: { ...(tenant.usageLimits as object), maxDocuments: 1 } },
    });
    expect(
      (await upload(other.client, "a.txt", "First document text", { collectionId: cid })).statusCode,
    ).toBe(201);
    const second = await upload(other.client, "b.txt", "Second document text", { collectionId: cid });
    expect(second.statusCode).toBe(403);
    expect(second.json().code).toBe("USAGE_LIMIT_EXCEEDED");
  });

  it("keeps the old version searchable until its replacement is ready", async () => {
    const v1 = (
      await upload(owner.client, "menu.txt", "Our special dish is the paneer butter masala.")
    ).json();
    await ingest(owner.me.tenant.id, v1.id);

    const m = multipart(
      {},
      { name: "menu-v2.txt", content: "Our special dish is now the malabar fish curry." },
    );
    const res = await owner.client.request("POST", `/api/v1/documents/${v1.id}/replace`, m.body, {
      headers: m.headers,
    });
    expect(res.statusCode).toBe(201);
    const v2 = res.json();
    expect(v2).toMatchObject({ version: 2, replacesId: v1.id, title: "menu", status: "PROCESSING" });

    const before = (await search(owner.client, { query: "special dish" })).json().hits;
    expect(before.map((h: { documentId: string }) => h.documentId)).toContain(v1.id);
    expect(before.map((h: { documentId: string }) => h.documentId)).not.toContain(v2.id);

    await ingest(owner.me.tenant.id, v2.id);
    const after = (await search(owner.client, { query: "special dish" })).json().hits;
    expect(after[0]).toMatchObject({ documentId: v2.id });
    expect(after.map((h: { documentId: string }) => h.documentId)).not.toContain(v1.id);
    expect((await owner.client.get(`/api/v1/documents/${v1.id}`)).statusCode).toBe(404);
  });

  it("reprocesses only finished documents", async () => {
    const doc = (
      await upload(owner.client, "hours.txt", "We are open on public holidays from 10 AM.")
    ).json();
    expect((await owner.client.post(`/api/v1/documents/${doc.id}/reprocess`)).statusCode).toBe(409);
    await ingest(owner.me.tenant.id, doc.id);
    const res = await owner.client.post(`/api/v1/documents/${doc.id}/reprocess`);
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("PROCESSING");
    expect(await ingest(owner.me.tenant.id, doc.id)).toBe("ready");
    const chunks = await app
      .get(TenantDbService)
      .db(owner.me.tenant.id)
      .documentChunk.count({ where: { documentId: doc.id } });
    expect(chunks).toBe(1); // replaced, not duplicated
  });

  it("hides disabled documents and respects agent restrictions", async () => {
    const doc = (await upload(owner.client, "valet.txt", "Valet service costs 200 rupees per visit.")).json();
    await ingest(owner.me.tenant.id, doc.id);
    const ids = async (body: Record<string, unknown>) =>
      (await search(owner.client, body)).json().hits.map((h: { documentId: string }) => h.documentId);

    expect(await ids({ query: "valet service" })).toContain(doc.id);
    await owner.client.patch(`/api/v1/documents/${doc.id}`, { enabled: false });
    expect(await ids({ query: "valet service" })).not.toContain(doc.id);
    await owner.client.patch(`/api/v1/documents/${doc.id}`, { enabled: true });

    const agent = async () =>
      (
        await owner.client.post("/api/v1/agents", {
          name: `A ${randomUUID().slice(0, 6)}`,
          templateKey: "clinic-reception",
        })
      ).json().id as string;
    const [a, b] = [await agent(), await agent()];
    const patched = await owner.client.patch(`/api/v1/documents/${doc.id}`, { agentIds: [a] });
    expect(patched.json().agents).toEqual([expect.objectContaining({ id: a })]);
    expect(await ids({ query: "valet service", agentId: a })).toContain(doc.id);
    expect(await ids({ query: "valet service", agentId: b })).not.toContain(doc.id);
    expect(
      (await owner.client.patch(`/api/v1/documents/${doc.id}`, { agentIds: [randomUUID()] })).statusCode,
    ).toBe(400);
  });

  it("refuses to publish an agent pointing at a missing collection", async () => {
    const id = (
      await owner.client.post("/api/v1/agents", { name: "Knowledge agent", templateKey: "clinic-reception" })
    ).json().id;
    const draft = (await owner.client.get(`/api/v1/agents/${id}`)).json().draft.config;
    draft.knowledge.collectionIds = [collectionId, randomUUID()];
    expect(
      (await owner.client.request("PUT", `/api/v1/agents/${id}/draft`, { config: draft })).statusCode,
    ).toBe(200);
    const res = await owner.client.post(`/api/v1/agents/${id}/publish`);
    expect(res.statusCode).toBe(400);
    expect(res.json().errors).toEqual([
      expect.objectContaining({ path: "config.knowledge.collectionIds.1" }),
    ]);

    draft.knowledge.collectionIds = [collectionId];
    await owner.client.request("PUT", `/api/v1/agents/${id}/draft`, { config: draft });
    expect((await owner.client.post(`/api/v1/agents/${id}/publish`)).statusCode).toBe(201);
  });

  it("isolates tenants and enforces permissions", async () => {
    const outsider = await registerOwner(app, "knowledge-outsider");
    const docs = (await owner.client.get("/api/v1/documents")).json().items;
    expect(docs.length).toBeGreaterThan(0);
    expect((await outsider.client.get(`/api/v1/documents/${docs[0].id}`)).statusCode).toBe(404);
    expect((await outsider.client.get(`/api/v1/documents/${docs[0].id}/download`)).statusCode).toBe(404);
    expect((await outsider.client.get("/api/v1/documents")).json().items).toEqual([]);
    expect((await search(outsider.client, { query: "parking clinic" })).json().hits).toEqual([]);
    expect((await upload(outsider.client, "x.txt", "Cross-tenant upload attempt")).statusCode).toBe(400);

    const manager = await addMember(app, owner, "MANAGER");
    expect((await manager.client.get("/api/v1/documents")).statusCode).toBe(200);
    expect((await upload(manager.client, "m.txt", "Manager upload attempt")).statusCode).toBe(403);
    const staff = await addMember(app, owner, "STAFF");
    expect((await staff.client.get("/api/v1/documents")).statusCode).toBe(403);
  });

  it("deletes documents and only empty collections", async () => {
    const doc = (await upload(owner.client, "temp.txt", "Temporary document content")).json();
    expect(doc.storageKey).toBeUndefined();
    const { storageKey } = await app
      .get(TenantDbService)
      .db(owner.me.tenant.id)
      .document.findUniqueOrThrow({ where: { id: doc.id } });
    expect((await owner.client.delete(`/api/v1/knowledge/collections/${collectionId}`)).statusCode).toBe(409);
    expect((await owner.client.delete(`/api/v1/documents/${doc.id}`)).statusCode).toBe(204);
    expect((await owner.client.get(`/api/v1/documents/${doc.id}`)).statusCode).toBe(404);
    const storage = app.get(StorageService).storage;
    await expect(storage.get(storageKey)).rejects.toBeTruthy();

    const empty = (await owner.client.post("/api/v1/knowledge/collections", { name: "Empty one" })).json();
    expect((await owner.client.delete(`/api/v1/knowledge/collections/${empty.id}`)).statusCode).toBe(204);
    const list = (await owner.client.get("/api/v1/knowledge/collections")).json().items;
    expect(list.find((c: { id: string }) => c.id === collectionId).documentCount).toBeGreaterThan(0);
  });
});
