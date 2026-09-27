import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TenantDbService } from "../src/infra/tenant-db.service";
import { createTestApp, hasTestDb, registerOwner } from "./support/app";
import { provisionAgent } from "./support/telephony";
import { fakeGraph, metaId, waitFor, webhookPoster } from "./support/whatsapp";

const APP_SECRET = "meta-app-secret-connection-0123";
const APP_ID = "1234567890";

describe.skipIf(!hasTestDb)("WhatsApp connection: business app numbers, checks and Meta's news", () => {
  let app: NestFastifyApplication;
  let owner: Awaited<ReturnType<typeof registerOwner>>;
  let graph: ReturnType<typeof fakeGraph>;
  const APP_WABA = metaId();
  const APP_PNID = metaId();
  const NEW_WABA = metaId();
  const NEW_PNID = metaId();
  const db = () => app.get(TenantDbService).db(owner.me.tenant.id);
  const number = (pnid: string) => db().whatsAppNumber.findFirstOrThrow({ where: { phoneNumberId: pnid } });

  beforeAll(async () => {
    app = await createTestApp({
      META_APP_ID: APP_ID,
      META_APP_SECRET: APP_SECRET,
      META_EMBEDDED_SIGNUP_CONFIG_ID: "9876543210",
      WHATSAPP_VERIFY_TOKEN: "verify-token-connection-0123",
      WHATSAPP_REPLY_DELAY_MS: "100",
    });
    owner = await registerOwner(app, "wa-conn");
    graph = fakeGraph({ [APP_WABA]: [APP_PNID], [NEW_WABA]: [NEW_PNID] });
    graph.state.appId = APP_ID;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
  });

  it("keeps a number on the WhatsApp Business app: never registered, and the owner's replies pause the agent", async () => {
    const agent = await provisionAgent(app, owner.me.tenant.id, "clinic-reception", {
      workingHours: undefined,
    } as never);
    const res = await owner.client.post("/api/v1/whatsapp/connect/embedded-signup", {
      code: "coexistence-code-123",
      wabaId: APP_WABA,
      phoneNumberId: APP_PNID,
      agentId: agent.agentId,
      onBusinessApp: true,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      status: "CONNECTED",
      onBusinessApp: true,
      messagingLimit: "TIER_1K",
      health: { token: "ok", registered: null, webhookSubscribed: true },
    });
    // Registering would log the owner's app out: never done for these numbers
    expect(graph.calls.some((c) => c.path === `/${APP_PNID}/register`)).toBe(false);
    expect(graph.state.subscribed.has(APP_WABA)).toBe(true);
    const id = (await number(APP_PNID)).id;
    expect((await owner.client.post(`/api/v1/whatsapp/numbers/${id}/register`, {})).statusCode).toBe(409);

    // A customer writes: the agent answers, and Meta's webhooks are recorded as arriving
    const hook = webhookPoster(app, APP_SECRET, APP_PNID, APP_WABA);
    const from = "97455300001";
    await hook.text(from, "Mariam", "Hi");
    const conv = await waitFor(() =>
      db()
        .conversation.findFirst({ where: { contactWaId: from }, include: { messages: true } })
        .then((c) => (c?.messages.some((m) => m.sender === "AI") ? c : null)),
    );
    expect((await number(APP_PNID)).lastWebhookAt).not.toBeNull();

    // The owner answers from the phone: shown in the Inbox, and the agent steps back
    expect((await hook.echo(from, "Hi Mariam, I'll call you in 5 minutes")).statusCode).toBe(200);
    const after = await db().conversation.findUniqueOrThrow({
      where: { id: conv.id },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    expect(after.mode).toBe("HUMAN");
    expect(
      after.messages.find((m) => m.meta && (m.meta as { fromBusinessApp?: boolean }).fromBusinessApp),
    ).toMatchObject({
      direction: "OUTBOUND",
      sender: "STAFF",
      status: "SENT",
      text: "Hi Mariam, I'll call you in 5 minutes",
    });
    expect(after.messages.some((m) => m.type === "NOTE" && /WhatsApp Business app/.test(m.text ?? ""))).toBe(
      true,
    );
    // The same echo again (Meta retries) is stored once
    const repeated = await db().conversationMessage.count({
      where: { conversationId: conv.id, sender: "STAFF" },
    });
    expect(repeated).toBe(1);

    const aiBefore = after.messages.filter((m) => m.sender === "AI").length;
    await hook.text(from, "Mariam", "Great, thanks");
    await new Promise((r) => setTimeout(r, 600));
    expect(await db().conversationMessage.count({ where: { conversationId: conv.id, sender: "AI" } })).toBe(
      aiBefore,
    );
  });

  it("checks the connection: finds an unregistered number, registers it with the owner's PIN, re-subscribes webhooks", async () => {
    graph.state.unregistered.add(NEW_PNID);
    graph.state.pins.set(NEW_PNID, "654321");
    const res = await owner.client.post("/api/v1/whatsapp/connect/manual", {
      accessToken: "biz-token-manual-0123456789",
      wabaId: NEW_WABA,
      phoneNumberId: NEW_PNID,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      status: "PENDING",
      lastError: expect.stringMatching(/Not registered/),
      health: { registered: false, platformType: "NOT_APPLICABLE" },
    });
    const id = res.json().id as string;

    // Without the PIN the owner set, Meta refuses; with it, the number is registered
    const wrong = await owner.client.post(`/api/v1/whatsapp/numbers/${id}/register`, {});
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().detail).toMatch(/PIN/);
    expect(
      (await owner.client.post(`/api/v1/whatsapp/numbers/${id}/register`, { pin: "12" })).statusCode,
    ).toBe(400);
    const ok = await owner.client.post(`/api/v1/whatsapp/numbers/${id}/register`, { pin: "654321" });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ status: "CONNECTED", lastError: null, health: { registered: true } });

    // Someone removed the app from the account in Meta: the check subscribes it again
    graph.state.subscribed.delete(NEW_WABA);
    const checked = await owner.client.post(`/api/v1/whatsapp/numbers/${id}/check`, {});
    expect(checked.json().health).toMatchObject({ webhookSubscribed: true, resubscribed: true });
    expect(graph.state.subscribed.has(NEW_WABA)).toBe(true);

    // The token stops working: the check says so and asks to reconnect
    graph.state.revokedTokens.add("biz-token-manual-0123456789");
    const revoked = (await owner.client.post(`/api/v1/whatsapp/numbers/${id}/check`, {})).json();
    expect(revoked).toMatchObject({
      health: { token: "rejected" },
      lastError: expect.stringMatching(/rejected the access token/),
    });
    graph.state.revokedTokens.clear();
    const fine = (await owner.client.post(`/api/v1/whatsapp/numbers/${id}/check`, {})).json();
    expect(fine).toMatchObject({ health: { token: "ok" }, lastError: null });
  });

  it("shows Meta's account and quality news on the number", async () => {
    const hook = webhookPoster(app, APP_SECRET, NEW_PNID, NEW_WABA);
    const n = () => number(NEW_PNID);

    await hook.postField("phone_number_quality_update", {
      display_phone_number: "97440005555",
      event: "FLAGGED",
      current_limit: "TIER_250",
    });
    expect(await n()).toMatchObject({
      qualityRating: "RED",
      messagingLimit: "TIER_250",
      lastError: expect.stringMatching(/flagged/),
    });
    await hook.postField("phone_number_quality_update", {
      display_phone_number: "97440005555",
      event: "UNFLAGGED",
    });
    expect(await n()).toMatchObject({ qualityRating: "GREEN", lastError: null });
    await hook.postField("phone_number_quality_update", {
      display_phone_number: "97440005555",
      event: "UPGRADE",
      current_limit: "TIER_10K",
    });
    expect((await n()).messagingLimit).toBe("TIER_10K");

    await hook.postField("account_update", { event: "PARTNER_REMOVED" });
    expect((await n()).lastError).toMatch(/removed this platform's access/);
    // News for another account, or for another number in it, changes nothing here
    await webhookPoster(app, APP_SECRET, NEW_PNID, metaId()).postField("account_update", { event: "BAN" });
    await hook.postField("account_update", { phone_number: "97411112222", event: "ACCOUNT_VIOLATION" });
    expect((await n()).lastError).toMatch(/removed this platform's access/);

    // The settings page lists what the Meta app must subscribe to
    const overview = (await owner.client.get("/api/v1/whatsapp")).json();
    expect(overview.platform.webhookFields).toEqual([
      "messages",
      "smb_message_echoes",
      "account_update",
      "phone_number_quality_update",
    ]);
  });
});
