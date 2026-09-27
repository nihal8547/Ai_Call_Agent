import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TenantDbService } from "../src/infra/tenant-db.service";
import { TenantSettingsService } from "../src/modules/telephony/tenant-settings.service";
import { createTestApp, hasTestDb, registerOwner } from "./support/app";
import { provisionAgent } from "./support/telephony";
import { fakeGraph, metaId, waitFor, webhookPoster } from "./support/whatsapp";

const APP_SECRET = "meta-app-secret-agent-0123456789";

describe.skipIf(!hasTestDb)("WhatsApp: the agent answers customers", () => {
  let app: NestFastifyApplication;
  let owner: Awaited<ReturnType<typeof registerOwner>>;
  let graph: ReturnType<typeof fakeGraph>;
  let hook: ReturnType<typeof webhookPoster>;
  let agent: Awaited<ReturnType<typeof provisionAgent>>;
  const WABA = metaId();
  const PNID = metaId();
  const db = () => app.get(TenantDbService).db(owner.me.tenant.id);

  /** The customer writes; resolves with the agent's reply once it was sent to Meta */
  async function say(from: string, text: string, name = "Aisha") {
    const before = graph.texts().filter((t) => t.to === from).length;
    expect((await hook.text(from, name, text)).statusCode).toBe(200);
    return waitFor(async () => {
      const mine = graph.texts().filter((t) => t.to === from);
      return mine.length > before ? mine.at(-1)!.text : null;
    });
  }
  const conversationOf = (from: string) =>
    db().conversation.findFirstOrThrow({ where: { contactWaId: from }, orderBy: { createdAt: "desc" } });

  beforeAll(async () => {
    app = await createTestApp({ META_APP_SECRET: APP_SECRET, WHATSAPP_REPLY_DELAY_MS: "150" });
    owner = await registerOwner(app, "wa-agent");
    graph = fakeGraph({ [WABA]: [PNID] });
    agent = await provisionAgent(app, owner.me.tenant.id, "clinic-reception", {
      workingHours: undefined,
      handoff: {
        enabled: true,
        phoneNumber: "+97444440000",
        message: "Connecting you now.",
        notifyEmails: ["frontdesk@clinic.test"],
      },
    } as never);
    const connected = await owner.client.post("/api/v1/whatsapp/connect/manual", {
      accessToken: "biz-token-agent-0123456789",
      wabaId: WABA,
      phoneNumberId: PNID,
      agentId: agent.agentId,
    });
    expect(connected.statusCode).toBe(201);
    hook = webhookPoster(app, APP_SECRET, PNID);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
  });

  it("greets, answers and books an appointment in a written conversation", async () => {
    const from = "97455100001";
    const first = await say(from, "Hi, I'd like to book a dental cleaning");
    // Greeting first, then straight to the next thing it needs (it understood "cleaning")
    expect(first).toContain("XYZ Dental Clinic");
    expect(first).toMatch(/\n\n/);
    expect(first).toMatch(/name/i);

    expect(await say(from, "Aisha Khan")).toMatch(/emergency|week|flexible/i);
    expect(await say(from, "Flexible")).toMatch(/day/i);
    expect(await say(from, "tomorrow")).toMatch(/time/i);
    expect(await say(from, "10 am")).toMatch(/Shall I confirm\?/);
    const done = await say(from, "yes");
    expect(done).toMatch(/confirmed/i);

    const c = await conversationOf(from);
    expect(c.mode).toBe("CLOSED"); // the workflow ended the conversation
    const appointment = await db().appointment.findFirstOrThrow({ where: { conversationId: c.id } });
    expect(appointment.title).toBe("Dental cleaning: Aisha Khan");
    const lead = await db().lead.findUniqueOrThrow({ where: { id: c.leadId! } });
    expect(lead).toMatchObject({ source: "whatsapp", customerName: "Aisha Khan", phone: "+97455100001" });
    expect(appointment.leadId).toBe(lead.id);

    // Staff see which messages the agent wrote, and the reply quoted nothing / used no fake data
    const messages = await db().conversationMessage.findMany({
      where: { conversationId: c.id, sender: "AI" },
      orderBy: { createdAt: "asc" },
    });
    expect(messages.length).toBe(6);
    expect(messages.every((m) => m.status === "SENT" && m.wamid)).toBe(true);
    // Metered: one WhatsApp message per reply
    const usage = await db().usageRecord.aggregate({
      where: { kind: "WHATSAPP_MESSAGES", createdAt: { gte: c.createdAt } },
      _sum: { quantity: true },
    });
    expect(Number(usage._sum.quantity)).toBeGreaterThanOrEqual(6);
  });

  it("answers several quick messages with one reply", async () => {
    const from = "97455100002";
    const sent = () => graph.texts().filter((t) => t.to === from).length;
    await hook.text(from, "Omar", "Hello");
    await hook.text(from, "Omar", "I need a root canal");
    await waitFor(async () => sent() >= 1);
    await new Promise((r) => setTimeout(r, 600));
    expect(sent()).toBe(1);
    const reply = graph.texts().filter((t) => t.to === from)[0]!.text;
    expect(reply).toMatch(/name/i);
    // Read receipt with "typing…" for the latest message
    expect(graph.calls.some((c) => c.body?.status === "read" && c.body?.typing_indicator)).toBe(true);
  });

  it("hands an emergency to staff: stops replying, notes it and emails the front desk", async () => {
    const from = "97455100003";
    // A bare greeting isn't taken as the patient's name: the agent greets and asks for it
    expect(await say(from, "Hi")).toBe(
      "Hello, you've reached XYZ Dental Clinic. I'm Maya, and I can help you book an appointment.\n\nMay I have the patient's name?",
    );
    await say(from, "Khalid");
    await say(from, "Root canal");
    const handoff = await say(from, "It's an emergency");
    expect(handoff).toBe(
      "Thanks, I've passed your conversation to our team. Someone will reply here shortly.",
    );

    const c = await conversationOf(from);
    expect(c.mode).toBe("HUMAN");
    const note = await db().conversationMessage.findFirstOrThrow({
      where: { conversationId: c.id, sender: "SYSTEM" },
    });
    expect(note.text).toContain("The customer asked for a person (Emergency)");
    expect(note.text).toContain("Patient name: Khalid");

    // The email goes through the notifications queue; without an email integration it lands in failed jobs
    const failed = await waitFor(() =>
      db().failedJob.findFirst({ where: { label: { contains: "WhatsApp hand-over email" } } }),
    );
    expect(failed.queue).toBe("notifications");
    expect((failed.payload as { subject: string }).subject).toContain("would like to talk to someone");

    // Staff are on it now: the agent stays quiet
    const count = graph.texts().filter((t) => t.to === from).length;
    await hook.text(from, "Khalid", "Hello?");
    await new Promise((r) => setTimeout(r, 700));
    expect(graph.texts().filter((t) => t.to === from).length).toBe(count);

    // Handed back: the agent answers new messages again (not the ones staff already saw)
    expect((await owner.client.post(`/api/v1/chats/${c.id}/mode`, { mode: "AI" })).statusCode).toBe(200);
    const back = await say(from, "Can I still book?");
    expect(back.length).toBeGreaterThan(0);
  });

  it("asks voice-note senders to type (until voice support)", async () => {
    const from = "97455100004";
    const before = graph.texts().filter((t) => t.to === from).length;
    await hook.voice(from, "Sara");
    const reply = await waitFor(async () => {
      const mine = graph.texts().filter((t) => t.to === from);
      return mine.length > before ? mine.at(-1)!.text : null;
    });
    expect(reply).toBe("Sorry, I can't listen to voice messages yet. Could you type your message?");
  });

  it("stays quiet without a published agent, and for blocked numbers", async () => {
    const number = await db().whatsAppNumber.findFirstOrThrow({ where: { phoneNumberId: PNID } });
    await db().whatsAppNumber.update({ where: { id: number.id }, data: { agentId: null } });
    const from = "97455100005";
    await hook.text(from, "Nour", "Hi there");
    const c = await waitFor(() =>
      db().conversation.findFirst({ where: { contactWaId: from, agentHandledAt: { not: null } } }),
    );
    expect(graph.texts().filter((t) => t.to === from)).toHaveLength(0);
    expect(c.mode).toBe("AI");
    await db().whatsAppNumber.update({ where: { id: number.id }, data: { agentId: agent.agentId } });

    await db().blockedCaller.create({ data: { tenantId: owner.me.tenant.id, pattern: "+97455100006" } });
    app.get(TenantSettingsService).forget(owner.me.tenant.id); // settings are cached for a minute
    await hook.text("97455100006", "Spam", "Buy now");
    await waitFor(() =>
      db().conversation.findFirst({ where: { contactWaId: "97455100006", agentHandledAt: { not: null } } }),
    );
    expect(graph.texts().filter((t) => t.to === "97455100006")).toHaveLength(0);
  });
});
