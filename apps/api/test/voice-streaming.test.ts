import { type NestFastifyApplication } from "@nestjs/platform-fastify";
import { twilioSignature } from "@platform/telephony";
import type { AddressInfo } from "node:net";
import { randomInt } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { TenantDbService } from "../src/infra/tenant-db.service";
import { createTestApp, hasTestDb, PUBLIC_URL, registerOwner, TWILIO_TOKEN } from "./support/app";
import { DEFAULT_CALLER, provisionAgent, twilioPost } from "./support/telephony";

const RELAY_URL = `${PUBLIC_URL.replace(/^http/, "ws")}/telephony/twilio/relay`;
const FILLER = "One moment, please.";

type Relay = {
  ws: WebSocket;
  /** Everything Twilio would have received, in order */
  received: Record<string, unknown>[];
  fillers: () => number;
  /** The next reply (fillers skipped): text to speak, or the end of the session */
  next: (timeoutMs?: number) => Promise<Record<string, unknown>>;
  say: (text: string) => Promise<Record<string, unknown>>;
  send: (m: Record<string, unknown>) => void;
  closed: Promise<number>;
};

function unescape(s: string) {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

describe.skipIf(!hasTestDb)("streaming voice (Twilio ConversationRelay)", () => {
  let app: NestFastifyApplication;
  let port: number;
  let owner: Awaited<ReturnType<typeof registerOwner>>;
  let agent: Awaited<ReturnType<typeof provisionAgent>>;
  const db = () => app.get(TenantDbService).db(owner.me.tenant.id);

  beforeAll(async () => {
    app = await createTestApp({
      // A filler before every reply here (in production only after 3 s), and quick silences
      RELAY_FILLER_MS: "1",
      RELAY_SILENCE_MS: "1500",
      RELAY_SPEECH_CHAR_MS: "0",
    });
    await app.listen(0, "127.0.0.1");
    port = (app.getHttpServer().address() as AddressInfo).port;
    owner = await registerOwner(app, "relay");
    agent = await provisionAgent(app, owner.me.tenant.id, "clinic-reception", {
      workingHours: undefined,
      voice: { mode: "streaming" },
    } as never);
  });
  afterAll(() => app.close());

  /** The call arrives: Twilio gets <Connect><ConversationRelay> */
  async function dial(callSid = `CA${randomInt(1e9, 9e9)}${Date.now()}`) {
    const base = { CallSid: callSid, From: DEFAULT_CALLER, To: agent.e164, CallStatus: "in-progress" };
    const { res } = await twilioPost(app, "/telephony/twilio/voice", base);
    const xml = res.body;
    return {
      base,
      callSid,
      xml,
      greeting: unescape(/welcomeGreeting="([^"]*)"/.exec(xml)?.[1] ?? ""),
      url: unescape(/<ConversationRelay[^>]* url="([^"]*)"/.exec(xml)?.[1] ?? ""),
      token: unescape(/<Parameter name="token" value="([^"]*)"/.exec(xml)?.[1] ?? ""),
    };
  }

  /** Connect as Twilio would: signed handshake, then "setup" with the call's parameters */
  async function connect(
    callSid: string,
    token: string,
    o: { signature?: string | null; path?: string; sessionId?: string } = {},
  ): Promise<Relay> {
    const signature = o.signature === undefined ? twilioSignature(TWILIO_TOKEN, RELAY_URL, {}) : o.signature;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${o.path ?? "/telephony/twilio/relay"}`, {
      headers: signature ? { "x-twilio-signature": signature } : {},
    });
    const received: Record<string, unknown>[] = [];
    const waiting: ((m: Record<string, unknown>) => void)[] = [];
    let unread: Record<string, unknown>[] = [];
    ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as Record<string, unknown>;
      received.push(m);
      if (m.type === "text" && m.token === FILLER) return;
      const w = waiting.shift();
      if (w) w(m);
      else unread.push(m);
    });
    const closed = new Promise<number>((resolve) => {
      ws.on("close", (code) => resolve(code));
      ws.on("error", () => resolve(-1));
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? -1));
    });
    await Promise.race([new Promise((r) => ws.on("open", r)), closed]);
    const send = (m: Record<string, unknown>) => ws.send(JSON.stringify(m));
    if (ws.readyState === WebSocket.OPEN)
      send({
        type: "setup",
        sessionId: o.sessionId ?? `VX${callSid}`,
        callSid,
        from: DEFAULT_CALLER,
        to: agent.e164,
        customParameters: { token },
      });
    const next = (timeoutMs = 10_000) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const m = unread.shift();
        if (m) return resolve(m);
        const t = setTimeout(() => reject(new Error("no reply")), timeoutMs);
        waiting.push((x) => {
          clearTimeout(t);
          resolve(x);
        });
      });
    return {
      ws,
      received,
      fillers: () => received.filter((m) => m.token === FILLER).length,
      next,
      send,
      say: (text) => {
        unread = [];
        send({ type: "prompt", voicePrompt: text, lang: "en-IN", last: true });
        return next();
      },
      closed,
    };
  }

  it("hands the call to a streaming session and books an appointment through it", async () => {
    const call = await dial();
    expect(call.xml).toContain(
      '<Connect action="https://voice.test/telephony/twilio/relay-end" method="POST">',
    );
    expect(call.url).toBe(RELAY_URL);
    expect(call.xml).toContain('ttsProvider="Amazon" voice="Kajal-Neural" transcriptionProvider="Deepgram"');
    expect(call.greeting).toBe(
      "Hello, you've reached XYZ Dental Clinic. I'm Maya, and I can help you book an appointment. May I have the patient's name?",
    );
    expect(call.token.length).toBeGreaterThan(20);

    const relay = await connect(call.callSid, call.token);
    expect((await relay.say("Priya")).token).toMatch(/Which service/);
    expect((await relay.say("cleaning")).token).toMatch(/emergency/i);
    expect((await relay.say("my number is 98765 43210 and I'm flexible")).token).toMatch(/Which day/);
    expect((await relay.say("tomorrow")).token).toMatch(/What time/);
    // The caller talks over the agent: Twilio stops speaking and reports it, then the words
    relay.send({ type: "interrupt", utteranceUntilInterrupt: "Shall I", durationUntilInterruptMs: 400 });
    expect((await relay.say("10 am")).token).toMatch(/Shall I confirm/);
    const end = await relay.say("yes");
    expect(end.type).toBe("end");
    expect(JSON.parse(String(end.handoffData))).toEqual({ reason: "hangup" });
    // A slow reply gets "one moment" first
    expect(relay.fillers()).toBeGreaterThan(0);

    // Twilio asks what next: the agent's last words, then hang up
    const after = await twilioPost(app, "/telephony/twilio/relay-end", {
      ...call.base,
      SessionStatus: "ended",
      HandoffData: String(end.handoffData),
    });
    expect(after.twiml.say).toContain("Your appointment is confirmed");
    expect(after.twiml.hangup).toBe(true);
    relay.ws.close();

    await twilioPost(app, "/telephony/twilio/status", {
      ...call.base,
      CallStatus: "completed",
      CallDuration: "95",
    });
    const record = await db().call.findUniqueOrThrow({
      where: { providerCallSid: call.callSid },
      include: { appointments: true, events: { orderBy: { seq: "asc" } } },
    });
    expect(record).toMatchObject({ outcome: "APPOINTMENT_BOOKED", status: "COMPLETED", totalTurns: 6 });
    expect(record.appointments).toHaveLength(1);
    expect(record.events[0]!.payload).toMatchObject({ mode: "streaming" });
    const userTurns = record.events.filter((e) => e.type === "USER_TURN").map((e) => e.payload);
    expect(userTurns.find((p) => (p as { bargeIn?: boolean }).bargeIn)).toMatchObject({ text: "10 am" });

    // Billed per streaming minute, not per recognised or spoken turn
    const usage = await db().usageRecord.findMany({ where: { callId: record.id } });
    const kinds = new Set(usage.map((u) => u.kind));
    expect(kinds.has("TTS_CHARACTERS")).toBe(false);
    expect(kinds.has("STT_SECONDS")).toBe(false);
    expect(usage.find((u) => u.kind === "VOICE_STREAMING_MINUTES")?.quantity.toString()).toBe("2");
  });

  it("refuses sessions without Twilio's signature, on other paths, or without the call's token", async () => {
    const call = await dial();
    expect(await (await connect(call.callSid, call.token, { signature: null })).closed).toBe(403);
    expect(await (await connect(call.callSid, call.token, { signature: "bm9wZQ==" })).closed).toBe(403);
    expect(await (await connect(call.callSid, call.token, { path: "/other" })).closed).toBe(404);
    expect(await (await connect(call.callSid, "wrong-token-".padEnd(32, "x"))).closed).toBe(1008);
    expect(await (await connect(`CA${randomInt(1e9, 9e9)}0000`, call.token)).closed).toBe(1008);

    // The real session works; a second one for the same call is refused
    const relay = await connect(call.callSid, call.token);
    expect((await relay.say("Priya")).token).toMatch(/Which service/);
    const other = await connect(call.callSid, call.token, { sessionId: "VXsomeone-else" });
    expect(await other.closed).toBe(1008);
    relay.ws.close();
  });

  it("carries on turn by turn when the stream breaks", async () => {
    const call = await dial();
    const relay = await connect(call.callSid, call.token);
    expect((await relay.say("Priya")).token).toMatch(/Which service/);
    relay.ws.close();
    await relay.closed;

    // Twilio asks what next without the agent having ended the session: back to <Gather>
    const after = await twilioPost(app, "/telephony/twilio/relay-end", {
      ...call.base,
      SessionStatus: "failed",
    });
    expect(after.twiml.xml).toContain("<Gather");
    expect(after.twiml.say).toMatch(/Which service/);
    const next = await twilioPost(app, after.twiml.next!, {
      ...call.base,
      SpeechResult: "cleaning",
      Confidence: "0.9",
    });
    expect(next.twiml.say).toMatch(/emergency/i);

    // The stream can't be reopened with the old token
    expect(await (await connect(call.callSid, call.token, { sessionId: "VXagain" })).closed).toBe(1008);
    const record = await db().call.findUniqueOrThrow({
      where: { providerCallSid: call.callSid },
      include: { events: { where: { type: "FALLBACK" } } },
    });
    expect(record.events.map((e) => e.payload)).toContainEqual({ reason: "streaming_ended" });
  });

  it("re-prompts a silent caller and takes keypad digits as an answer", async () => {
    const call = await dial();
    const relay = await connect(call.callSid, call.token);
    // Nobody speaks after the greeting
    const nudge = await relay.next(5000);
    expect(nudge.token).toMatch(/didn't catch that.*patient's name/);
    expect((await relay.say("Priya")).token).toMatch(/Which service/);
    for (const digit of ["1", "2", "#"]) relay.send({ type: "dtmf", digit });
    await relay.next();
    relay.ws.close();
    const record = await db().call.findUniqueOrThrow({
      where: { providerCallSid: call.callSid },
      include: { events: { where: { type: "USER_TURN" }, orderBy: { seq: "asc" } } },
    });
    expect(record.events.map((e) => e.payload)).toContainEqual({
      text: "12",
      confidence: null,
      keypad: true,
    });
  });
});
