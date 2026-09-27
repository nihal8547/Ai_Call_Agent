import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TenantDbService } from "../src/infra/tenant-db.service";
import { createTestApp, hasTestDb, registerOwner } from "./support/app";
import { fakeGraph, metaId, waitFor, webhookPoster } from "./support/whatsapp";

const APP_SECRET = "meta-app-secret-chat-0123456789";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(300, 1)]);

/** A multipart body as a browser sends it */
function multipart(parts: { name: string; value: string | Buffer; filename?: string; type?: string }[]) {
  const boundary = `----test${Date.now()}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ""}\r\n${p.type ? `Content-Type: ${p.type}\r\n` : ""}\r\n`,
      ),
      Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value),
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe.skipIf(!hasTestDb)("WhatsApp Inbox: files, attachments, templates, read receipts", () => {
  let app: NestFastifyApplication;
  let owner: Awaited<ReturnType<typeof registerOwner>>;
  let graph: ReturnType<typeof fakeGraph>;
  let hook: ReturnType<typeof webhookPoster>;
  const WABA = metaId();
  const PNID = metaId();
  const db = () => app.get(TenantDbService).db(owner.me.tenant.id);
  const conversation = (from: string) => db().conversation.findFirstOrThrow({ where: { contactWaId: from } });

  beforeAll(async () => {
    app = await createTestApp({
      META_APP_SECRET: APP_SECRET,
      WHATSAPP_REPLY_DELAY_MS: "50",
      WHATSAPP_MEDIA_MAX_MB: "1",
    });
    owner = await registerOwner(app, "wa-chat");
    graph = fakeGraph({ [WABA]: [PNID] });
    expect(
      (
        await owner.client.post("/api/v1/whatsapp/connect/manual", {
          accessToken: "biz-token-chat-0123456789",
          wabaId: WABA,
          phoneNumberId: PNID,
        })
      ).statusCode,
    ).toBe(201);
    hook = webhookPoster(app, APP_SECRET, PNID, WABA);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
  });

  /** Staff upload a file from the Inbox */
  const attach = (conversationId: string, file: Buffer, filename: string, caption?: string) => {
    const body = multipart([
      ...(caption ? [{ name: "caption", value: caption }] : []),
      { name: "file", value: file, filename, type: "application/octet-stream" },
    ]);
    return owner.client.request("POST", `/api/v1/chats/${conversationId}/attachments`, body.payload, {
      headers: { "content-type": body.contentType },
    });
  };

  it("keeps customers' photos and documents: photos show in the Inbox, documents download", async () => {
    const from = "97455400001";
    const photo = metaId();
    const doc = metaId();
    const huge = metaId();
    graph.media.set(photo, JPEG);
    graph.mediaTypes.set(photo, "image/jpeg");
    graph.media.set(doc, PDF);
    graph.mediaTypes.set(doc, "application/pdf");
    graph.media.set(huge, Buffer.alloc(1024 * 1024 + 10, 1));
    graph.mediaTypes.set(huge, "application/pdf");
    await hook.message(from, "Layla", {
      type: "image",
      image: { id: photo, mime_type: "image/jpeg", caption: "My X-ray" },
    });
    await hook.message(from, "Layla", {
      type: "document",
      document: { id: doc, mime_type: "application/pdf", filename: "report <1>.pdf" },
    });
    await hook.message(from, "Layla", {
      type: "document",
      document: { id: huge, mime_type: "application/pdf", filename: "scan.pdf" },
    });
    const c = await conversation(from);
    const stored = await waitFor(async () => {
      const m = await db().conversationMessage.findMany({
        where: { conversationId: c.id, direction: "INBOUND" },
        orderBy: { createdAt: "asc" },
      });
      return m.length === 3 && m.every((x) => x.mediaKey || (x.meta as { tooLarge?: boolean }).tooLarge)
        ? m
        : null;
    });
    expect(stored[0]).toMatchObject({ type: "IMAGE", text: "My X-ray", mediaMime: "image/jpeg" });
    expect(stored[2]!.meta).toMatchObject({ tooLarge: true });

    const url = (id: string) => `/api/v1/chats/${c.id}/messages/${id}/media`;
    const img = await owner.client.get(url(stored[0]!.id));
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/jpeg");
    expect(img.headers["content-disposition"]).toBe("inline");
    expect(img.rawPayload.equals(JPEG)).toBe(true);
    const pdf = await owner.client.get(url(stored[1]!.id));
    expect(pdf.headers["content-type"]).toBe("application/octet-stream");
    expect(pdf.headers["content-disposition"]).toBe(
      `attachment; filename="report _1_.pdf"; filename*=UTF-8''report%20%3C1%3E.pdf`,
    );
    expect((await owner.client.get(url(stored[2]!.id))).statusCode).toBe(404);
    const listed = (await owner.client.get(`/api/v1/chats/${c.id}/messages`)).json().items;
    expect(listed.filter((m: { hasMedia: boolean }) => m.hasMedia)).toHaveLength(2);
  });

  it("staff send photos and documents with a caption; unsupported or oversized files are refused", async () => {
    const from = "97455400002";
    await hook.text(from, "Omar", "Can you send the price list?");
    const c = await waitFor(() => db().conversation.findFirst({ where: { contactWaId: from } }));

    const sent = await attach(c.id, PDF, "Price list.pdf", "Our prices for 2026");
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({
      type: "DOCUMENT",
      text: "Our prices for 2026",
      hasMedia: true,
      status: "QUEUED",
    });
    const photo = await attach(c.id, JPEG, "clinic.jpg");
    expect(photo.statusCode).toBe(201);
    const files = await waitFor(async () => {
      const f = graph.files().filter((x) => x.to === from);
      return f.length === 2 ? f : null;
    });
    expect(files).toEqual([
      expect.objectContaining({
        type: "document",
        caption: "Our prices for 2026",
        filename: "Price list.pdf",
      }),
      expect.objectContaining({ type: "image" }),
    ]);
    const uploaded = graph.uploads.slice(-2);
    expect(uploaded.map((u) => u.type)).toEqual(["application/pdf", "image/jpeg"]);
    expect(uploaded[0]!.bytes.equals(PDF)).toBe(true);
    const conv = await db().conversation.findUniqueOrThrow({ where: { id: c.id } });
    expect(conv.mode).toBe("HUMAN");

    // What WhatsApp wouldn't take, by content rather than name
    expect((await attach(c.id, Buffer.from("MZ\x90\x00 not a pdf"), "invoice.pdf")).statusCode).toBe(415);
    expect((await attach(c.id, Buffer.from("#!/bin/sh\necho hi"), "run.sh")).statusCode).toBe(415);
    const bigPhoto = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5 * 1024 * 1024 + 1)]);
    expect((await attach(c.id, bigPhoto, "big.jpg")).statusCode).toBe(413);
  });

  it("after 24 hours: text is refused, an approved template goes out and reopens the chat", async () => {
    graph.state.templates = [
      {
        id: "T1",
        name: "appointment_reminder",
        language: "en",
        status: "APPROVED",
        category: "UTILITY",
        components: [
          { type: "HEADER", format: "TEXT", text: "Hello {{1}}" },
          { type: "BODY", text: "Your visit is on {{1}} at {{2}}." },
          { type: "FOOTER", text: "Pearl Dental" },
        ],
      },
      {
        id: "T2",
        name: "offer_photo",
        language: "en",
        status: "APPROVED",
        components: [
          { type: "HEADER", format: "IMAGE" },
          { type: "BODY", text: "Our new offer" },
        ],
      },
      {
        id: "T3",
        name: "draft_one",
        language: "en",
        status: "PENDING",
        components: [{ type: "BODY", text: "x" }],
      },
    ];
    const from = "97455400003";
    await hook.text(from, "Noor", "Hi");
    const c = await waitFor(() => db().conversation.findFirst({ where: { contactWaId: from } }));
    await db().conversation.update({
      where: { id: c.id },
      data: { lastInboundAt: new Date(Date.now() - 25 * 3600_000), mode: "CLOSED", closedAt: new Date() },
    });

    const text = await owner.client.post(`/api/v1/chats/${c.id}/messages`, { text: "Hello?" });
    expect(text.statusCode).toBe(409);

    const list = (await owner.client.get(`/api/v1/chats/${c.id}/templates`)).json().items;
    expect(list.map((t: { name: string; supported: boolean }) => [t.name, t.supported])).toEqual([
      ["appointment_reminder", true],
      ["offer_photo", false],
    ]);
    expect(list[0]).toMatchObject({ headerParams: 1, bodyParams: 2 });

    const post = (body: Record<string, unknown>) => owner.client.post(`/api/v1/chats/${c.id}/template`, body);
    expect((await post({ name: "appointment_reminder", language: "en", body: ["Sunday"] })).statusCode).toBe(
      400,
    );
    expect((await post({ name: "offer_photo", language: "en" })).statusCode).toBe(400);
    expect((await post({ name: "draft_one", language: "en", body: [] })).statusCode).toBe(400);
    const ok = await post({
      name: "appointment_reminder",
      language: "en",
      header: ["Noor"],
      body: ["Sunday", "10 AM"],
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({
      type: "TEMPLATE",
      text: "Hello Noor\n\nYour visit is on Sunday at 10 AM.\n\nPearl Dental",
    });
    const t = await waitFor(async () => graph.templates().find((x) => x.to === from));
    expect(t).toMatchObject({
      name: "appointment_reminder",
      language: { code: "en" },
      components: [
        { type: "header", parameters: [{ type: "text", text: "Noor" }] },
        {
          type: "body",
          parameters: [
            { type: "text", text: "Sunday" },
            { type: "text", text: "10 AM" },
          ],
        },
      ],
    });
    expect(await db().conversation.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      mode: "HUMAN",
      closedAt: null,
    });
  });

  it("opening a conversation sends blue ticks for the customer's last message (once)", async () => {
    const from = "97455400004";
    await hook.text(from, "Sara", "Are you open today?");
    const c = await waitFor(() => db().conversation.findFirst({ where: { contactWaId: from } }));
    await owner.client.post(`/api/v1/chats/${c.id}/mode`, { mode: "HUMAN" });
    const last = await db().conversationMessage.findFirstOrThrow({
      where: { conversationId: c.id, direction: "INBOUND" },
    });
    const before = graph.reads().length;
    expect((await owner.client.post(`/api/v1/chats/${c.id}/read`, {})).statusCode).toBe(204);
    await waitFor(async () => graph.reads().includes(last.wamid!));
    expect((await db().conversation.findUniqueOrThrow({ where: { id: c.id } })).unreadCount).toBe(0);
    // Nothing new: no second receipt
    await owner.client.post(`/api/v1/chats/${c.id}/read`, {});
    await new Promise((r) => setTimeout(r, 150));
    expect(graph.reads().length).toBe(before + 1);
  });
});
