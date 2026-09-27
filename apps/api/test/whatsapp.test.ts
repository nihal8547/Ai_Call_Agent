import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TenantDbService } from "../src/infra/tenant-db.service";
import { addMember, Client, createTestApp, hasTestDb, registerOwner } from "./support/app";

const APP_SECRET = "meta-app-secret-0123456789";
const VERIFY_TOKEN = "verify-token-0123456789";
// Unique per run: the test database outlives runs, and a phone number id can belong to one business only
const metaId = () => String(1e11 + Math.floor(Math.random() * 9e11));
const WABA = metaId();
const PNID = metaId();
const OTHER_WABA = metaId();
const OTHER_PNID = metaId();
/** Message ids are unique across the platform too */
const RUN = metaId();
const w = (id: string) => `${id}.${RUN}`;

// ── Meta's Graph API, faked behind fetch ────────────────────────────────────
type Seen = { method: string; path: string; body: Record<string, unknown> | null; auth: string };
const seen: Seen[] = [];
let sent = 0;
const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function installGraph() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "graph.facebook.com") return realFetch(input, init);
    const method = init.method ?? "GET";
    const path = url.pathname.replace(/^\/v23\.0/, "");
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const auth = String((init.headers as Record<string, string> | undefined)?.authorization ?? "");
    seen.push({ method, path, body, auth });
    const token = auth.replace("Bearer ", "");
    if (path === "/oauth/access_token")
      return url.searchParams.get("code") === "good-code-123"
        ? json({ access_token: "biz-token-embedded" })
        : json({ error: { code: 100, message: "Invalid verification code format." } }, 400);
    if (!token.startsWith("biz-token"))
      return json({ error: { code: 190, message: "Invalid OAuth access token." } }, 401);
    if (path === `/${WABA}/phone_numbers`) return json({ data: [{ id: PNID }] });
    if (path === `/${OTHER_WABA}/phone_numbers`) return json({ data: [{ id: OTHER_PNID }] });
    if (path === `/${PNID}` || path === `/${OTHER_PNID}`)
      return json({
        id: path.slice(1),
        display_phone_number: path === `/${PNID}` ? "+974 4000 1234" : "+974 4000 9999",
        verified_name: "Pearl Clinic",
        quality_rating: "GREEN",
        code_verification_status: "VERIFIED",
      });
    if (path.endsWith("/subscribed_apps") && method === "GET")
      return json({ data: [{ whatsapp_business_api_data: { id: "1234567890", name: "Platform" } }] });
    if (path.endsWith("/subscribed_apps") || path.endsWith("/register")) return json({ success: true });
    if (path.endsWith("/messages")) {
      if (body?.to === "97400000000")
        return json(
          {
            error: {
              code: 131047,
              message: "Re-engagement message",
              error_data: { details: "More than 24 hours" },
            },
          },
          400,
        );
      sent += 1;
      return json({ messages: [{ id: w(`wamid.OUT-${sent}`) }] });
    }
    return json({ error: { code: 100, message: `Unknown path ${path}` } }, 400);
  });
}

const webhookBody = (value: Record<string, unknown>, pnid = PNID) => ({
  object: "whatsapp_business_account",
  entry: [
    { id: WABA, changes: [{ field: "messages", value: { metadata: { phone_number_id: pnid }, ...value } }] },
  ],
});
const textMessage = (id: string, from: string, body: string, name = "Ahmed") => ({
  contacts: [{ wa_id: from, profile: { name } }],
  messages: [
    { from, id: w(id), timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } },
  ],
});

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 5000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!hasTestDb)("WhatsApp: connect, webhook, Inbox and sending", () => {
  let app: NestFastifyApplication;
  let owner: Awaited<ReturnType<typeof registerOwner>>;
  const db = () => app.get(TenantDbService).db(owner.me.tenant.id);

  const post = (payload: unknown, signature?: string) => {
    const raw = JSON.stringify(payload);
    return app.inject({
      method: "POST",
      url: "/api/v1/webhooks/whatsapp",
      payload: raw,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256":
          signature ?? `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`,
      },
    });
  };

  beforeAll(async () => {
    app = await createTestApp({
      META_APP_ID: "1234567890",
      META_APP_SECRET: APP_SECRET,
      META_EMBEDDED_SIGNUP_CONFIG_ID: "9876543210",
      WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
    });
    owner = await registerOwner(app, "whatsapp");
  });
  beforeEach(() => installGraph());
  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
  });

  it("answers Meta's verification with the right token only", async () => {
    const q = (token: string) =>
      app.inject({
        method: "GET",
        url: `/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1158201444`,
      });
    const ok = await q(VERIFY_TOKEN);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("1158201444");
    expect((await q("wrong-token-0123456789")).statusCode).toBe(403);
  });

  it("shows what's needed before anything is connected", async () => {
    const res = await owner.client.get("/api/v1/whatsapp");
    expect(res.json()).toEqual({
      platform: {
        embeddedSignup: true,
        appId: "1234567890",
        configId: "9876543210",
        graphVersion: "v23.0",
        webhookUrl: "https://voice.test/api/v1/webhooks/whatsapp",
        webhookReady: true,
        webhookFields: ["messages", "smb_message_echoes", "account_update", "phone_number_quality_update"],
        speech: false,
      },
      numbers: [],
    });
  });

  it("Continue with Facebook: checks the number belongs to the account, subscribes and registers it", async () => {
    const bad = await owner.client.post("/api/v1/whatsapp/connect/embedded-signup", {
      code: "wrong-code-123",
      wabaId: WABA,
      phoneNumberId: PNID,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().detail).toContain("Invalid verification code format");

    const notIn = await owner.client.post("/api/v1/whatsapp/connect/embedded-signup", {
      code: "good-code-123",
      wabaId: WABA,
      phoneNumberId: OTHER_PNID,
    });
    expect(notIn.statusCode).toBe(400);

    seen.length = 0;
    const res = await owner.client.post("/api/v1/whatsapp/connect/embedded-signup", {
      code: "good-code-123",
      wabaId: WABA,
      phoneNumberId: PNID,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      phoneNumberId: PNID,
      displayNumber: "+974 4000 1234",
      verifiedName: "Pearl Clinic",
      status: "CONNECTED",
      qualityRating: "GREEN",
    });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "GET /oauth/access_token",
      `GET /${WABA}/phone_numbers`,
      `GET /${PNID}`,
      `POST /${WABA}/subscribed_apps`,
      `POST /${PNID}/register`,
      // The first connection check: readiness fields, then the webhook subscription
      `GET /${PNID}`,
      `GET /${PNID}`,
      `GET /${WABA}/subscribed_apps`,
    ]);
    expect(String(seen[4]!.body?.pin)).toMatch(/^\d{6}$/);

    // The token is sealed and the integration is managed on the WhatsApp page only
    const integration = await db().integration.findFirstOrThrow({ where: { type: "WHATSAPP" } });
    expect(Buffer.from(integration.credentialsEncrypted).toString("latin1")).not.toContain("biz-token");
    const list = (await owner.client.get("/api/v1/integrations")).json();
    expect(list.items.map((i: { type: string }) => i.type)).not.toContain("WHATSAPP");
    expect((await owner.client.delete(`/api/v1/integrations/${integration.id}`)).statusCode).toBe(409);
  });

  it("only owners and admins connect; another business can't take the same number", async () => {
    const manager = await addMember(app, owner, "MANAGER");
    expect((await manager.client.get("/api/v1/whatsapp")).statusCode).toBe(200);
    const denied = await manager.client.post("/api/v1/whatsapp/connect/manual", {
      accessToken: "biz-token-manual-0123456789",
      wabaId: WABA,
      phoneNumberId: PNID,
    });
    expect(denied.statusCode).toBe(403);

    const other = await registerOwner(app, "whatsapp-other");
    const taken = await other.client.post("/api/v1/whatsapp/connect/manual", {
      accessToken: "biz-token-manual-0123456789",
      wabaId: WABA,
      phoneNumberId: PNID,
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().detail).toContain("already connected to another business");
  });

  it("refuses webhooks without Meta's signature", async () => {
    const payload = webhookBody(textMessage("wamid.fake", "97455000001", "hi"));
    expect((await post(payload, "sha256=00")).statusCode).toBe(401);
    expect((await post(payload, "")).statusCode).toBe(401);
    expect(await db().conversationMessage.count({ where: { wamid: w("wamid.fake") } })).toBe(0);
  });

  let conversationId = "";

  it("stores each message once, in one conversation, with the customer's name", async () => {
    const first = webhookBody(textMessage("wamid.IN-1", "97455123456", "Is the villa in Lusail available?"));
    const r1 = await post(first);
    expect(r1.statusCode, r1.body).toBe(200);
    expect((await post(first)).statusCode).toBe(200); // Meta retry
    await post(
      webhookBody({
        contacts: [{ wa_id: "97455123456", profile: { name: "Ahmed" } }],
        messages: [
          {
            from: "97455123456",
            id: w("wamid.IN-2"),
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: "audio",
            audio: { id: "MEDIA1", mime_type: "audio/ogg; codecs=opus", voice: true },
          },
        ],
      }),
    );
    // A number nobody connected is ignored
    expect(
      (await post(webhookBody(textMessage("wamid.X", "97455123456", "hi"), "999999999"))).statusCode,
    ).toBe(200);

    const list = await owner.client.get("/api/v1/chats");
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    const c = list.json().items[0];
    conversationId = c.id;
    expect(c).toMatchObject({
      contactName: "Ahmed",
      contactPhone: "+97455123456",
      mode: "AI",
      unreadCount: 2,
      lastMessagePreview: "Voice message",
      whatsappNumber: { displayNumber: "+974 4000 1234" },
    });
    expect(new Date(c.windowClosesAt).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect((await owner.client.get("/api/v1/chats/unread")).json()).toEqual({ conversations: 1 });

    const messages = (await owner.client.get(`/api/v1/chats/${conversationId}/messages`)).json().items;
    expect(messages.map((m: { type: string; text: string | null }) => [m.type, m.text])).toEqual([
      ["TEXT", "Is the villa in Lusail available?"],
      ["AUDIO", null],
    ]);
    expect(messages[1].mediaMime).toBe("audio/ogg; codecs=opus");

    expect((await owner.client.post(`/api/v1/chats/${conversationId}/read`)).statusCode).toBe(204);
    expect((await owner.client.get("/api/v1/chats/unread")).json()).toEqual({ conversations: 0 });
  });

  it("a staff reply takes over from the agent and is sent through the queue, with delivery ticks", async () => {
    const res = await owner.client.post(`/api/v1/chats/${conversationId}/messages`, {
      text: "Yes, it is. When would you like to visit?",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "QUEUED", sender: "STAFF", sentByName: "whatsapp owner" });

    const sentRow = await waitFor(() =>
      db().conversationMessage.findFirst({ where: { conversationId, sender: "STAFF", status: "SENT" } }),
    );
    expect(sentRow.wamid).toMatch(/^wamid\.OUT-/);
    const send = seen.filter((s) => s.path === `/${PNID}/messages`).at(-1)!;
    expect(send.auth).toBe("Bearer biz-token-embedded");
    expect(send.body).toMatchObject({
      to: "97455123456",
      type: "text",
      text: { body: "Yes, it is. When would you like to visit?" },
    });

    const detail = (await owner.client.get(`/api/v1/chats/${conversationId}`)).json();
    expect(detail.mode).toBe("HUMAN");
    const notes = (await owner.client.get(`/api/v1/chats/${conversationId}/messages`))
      .json()
      .items.filter((m: { sender: string }) => m.sender === "SYSTEM");
    // No agent answers this number, so there was nobody to take over from
    expect(notes.map((n: { text: string }) => n.text)).toEqual([]);

    const status = (s: string, ts: number) =>
      post(
        webhookBody({
          statuses: [{ id: sentRow.wamid, status: s, timestamp: String(ts), recipient_id: "97455123456" }],
        }),
      );
    const now = Math.floor(Date.now() / 1000);
    await status("delivered", now);
    await status("read", now + 1);
    await status("delivered", now + 2); // late: must not go backwards
    const after = await db().conversationMessage.findUniqueOrThrow({ where: { id: sentRow.id } });
    expect(after.status).toBe("READ");
    expect(after.readAt).not.toBeNull();
  });

  it("refuses free-form replies after 24 hours, and shows Meta's reason when sending fails", async () => {
    await db().conversation.update({
      where: { id: conversationId },
      data: { lastInboundAt: new Date(Date.now() - 25 * 3600_000) },
    });
    const late = await owner.client.post(`/api/v1/chats/${conversationId}/messages`, { text: "Hello?" });
    expect(late.statusCode).toBe(409);
    expect(late.json().code).toBe("WHATSAPP_WINDOW_CLOSED");
    await db().conversation.update({ where: { id: conversationId }, data: { lastInboundAt: new Date() } });

    // Meta still refuses (its own clock): the message shows as failed with the reason
    await post(webhookBody(textMessage("wamid.IN-Z", "97400000000", "hi", "Zed")));
    const z = (await owner.client.get("/api/v1/chats?q=Zed")).json().items[0];
    await owner.client.post(`/api/v1/chats/${z.id}/messages`, { text: "Hi Zed" });
    const failed = await waitFor(() =>
      db().conversationMessage.findFirst({ where: { conversationId: z.id, status: "FAILED" } }),
    );
    expect(failed.errorTitle).toContain("Re-engagement message");
    expect(failed.errorCode).toBe(131047);
  });

  it("hands back to the agent, closes, and a new message starts a new conversation", async () => {
    expect(
      (await owner.client.post(`/api/v1/chats/${conversationId}/mode`, { mode: "AI" })).json().mode,
    ).toBe("AI");
    expect(
      (await owner.client.post(`/api/v1/chats/${conversationId}/mode`, { mode: "CLOSED" })).json().mode,
    ).toBe("CLOSED");
    const closedReply = await owner.client.post(`/api/v1/chats/${conversationId}/messages`, { text: "x" });
    expect(closedReply.statusCode).toBe(409);

    await post(webhookBody(textMessage("wamid.IN-3", "97455123456", "Back again")));
    const open = (await owner.client.get("/api/v1/chats?q=Ahmed")).json().items;
    expect(open).toHaveLength(1);
    expect(open[0].id).not.toBe(conversationId);
    expect(
      (await owner.client.get("/api/v1/chats?filter=closed")).json().items.map((c: { id: string }) => c.id),
    ).toContain(conversationId);
  });

  it("keeps each business's conversations to itself", async () => {
    const other = await registerOwner(app, "whatsapp-peek");
    expect((await other.client.get(`/api/v1/chats/${conversationId}`)).statusCode).toBe(404);
    expect((await other.client.get(`/api/v1/chats/${conversationId}/messages`)).statusCode).toBe(404);
    expect(
      (await other.client.post(`/api/v1/chats/${conversationId}/messages`, { text: "hi" })).statusCode,
    ).toBe(404);
    expect((await other.client.get("/api/v1/chats")).json().items).toEqual([]);
    // Staff without chat access (a custom role) see nothing
    expect((await new Client(app).get("/api/v1/chats")).statusCode).toBe(401);
  });

  it("sends Meta's hello_world template as a test, then disconnects (history kept, webhooks ignored)", async () => {
    const number = (await owner.client.get("/api/v1/whatsapp")).json().numbers[0];
    const test = await owner.client.post(`/api/v1/whatsapp/numbers/${number.id}/test`, {
      to: "+97455123456",
    });
    expect(test.json()).toMatchObject({ ok: true });
    expect(seen.filter((s) => s.path === `/${PNID}/messages`).at(-1)!.body).toMatchObject({
      to: "97455123456",
      type: "template",
      template: { name: "hello_world", language: { code: "en_US" } },
    });

    expect((await owner.client.delete(`/api/v1/whatsapp/numbers/${number.id}`)).statusCode).toBe(204);
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", path: `/${WABA}/subscribed_apps` });
    expect((await owner.client.get("/api/v1/whatsapp")).json().numbers).toEqual([]);
    expect(await db().integration.count({ where: { type: "WHATSAPP" } })).toBe(0);

    await post(webhookBody(textMessage("wamid.IN-after", "97455123456", "Anyone?")));
    expect(await db().conversationMessage.count({ where: { wamid: w("wamid.IN-after") } })).toBe(0);
    expect((await owner.client.get("/api/v1/chats?filter=closed")).json().items.length).toBeGreaterThan(0);

    // Now free: another business can connect the number, and the first keeps its history
    const next = await registerOwner(app, "whatsapp-next");
    const taken = await next.client.post("/api/v1/whatsapp/connect/manual", {
      accessToken: "biz-token-manual-0123456789",
      wabaId: WABA,
      phoneNumberId: PNID,
    });
    expect(taken.statusCode).toBe(201);
    expect((await owner.client.get("/api/v1/chats?filter=closed")).json().items.length).toBeGreaterThan(0);
  });
});
