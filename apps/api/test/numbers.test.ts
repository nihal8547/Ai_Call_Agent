import { type NestFastifyApplication } from "@nestjs/platform-fastify";
import { randomInt } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisService } from "../src/infra/redis.service";
import { TenantDbService } from "../src/infra/tenant-db.service";
import { addMember, createTestApp, hasTestDb, registerOwner } from "./support/app";
import { phoneCall, provisionAgent, twilioPost } from "./support/telephony";

type Owner = Awaited<ReturnType<typeof registerOwner>>;

// ── A fake Twilio REST API (numbers and SIP domains) ──────────────────────────
const twilio = { requests: [] as { method: string; path: string; body: Record<string, string> }[], seq: 0 };
const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = new URL(req.url!, "http://x");
    const path = url.pathname.replace(/^\/2010-04-01\/Accounts\/AC[0-9a-f]+/, "");
    const body = Object.fromEntries(new URLSearchParams(raw));
    twilio.requests.push({ method: req.method!, path, body });
    const json = (status: number, v: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
    const sid = (p: string) => `${p}${String(++twilio.seq).padStart(32, "0")}`;
    if (path.startsWith("/AvailablePhoneNumbers/QA/Local.json"))
      return json(200, {
        available_phone_numbers: [
          { phone_number: TW1, friendly_name: TW1, locality: "", region: "Doha", iso_country: "QA", capabilities: { voice: true }, address_requirements: "none" },
        ],
      });
    if (path === "/IncomingPhoneNumbers.json" && req.method === "POST")
      return json(201, { sid: sid("PN"), phone_number: body.PhoneNumber, friendly_name: body.FriendlyName, voice_url: body.VoiceUrl });
    if (path.startsWith("/IncomingPhoneNumbers/") && req.method === "DELETE") return res.writeHead(204).end();
    if (path === "/SIP/Domains.json") return json(201, { sid: sid("SD"), domain_name: body.DomainName });
    if (path === "/SIP/IpAccessControlLists.json") return json(201, { sid: sid("AL") });
    if (path.endsWith("/IpAddresses.json") && req.method === "GET") return json(200, { ip_addresses: [] });
    if (path.endsWith("/IpAddresses.json")) return json(201, { sid: sid("IP") });
    if (path === "/SIP/CredentialLists.json") return json(201, { sid: sid("CL") });
    if (path.endsWith("/Credentials.json")) return json(201, { sid: sid("CR") });
    if (path.includes("Mappings.json")) return json(201, { sid: sid("MP") });
    if (req.method === "DELETE") return res.writeHead(204).end();
    json(404, { message: `unknown ${path}` });
  });
});

const QA_CALLER = "+97455123456";
// Numbers are unique platform-wide: fresh ones every run
const six = () => String(randomInt(100_000, 999_999));
const TW1 = `+97444${six()}`;
const TW2 = `+97444${six()}`;
const TW3 = `+97444${six()}`;
const BIZ = `44${six()}`;
const SIPN = `44${six()}`;
const local = (n: string) => `${n.slice(0, 4)} ${n.slice(4)}`;

describe.skipIf(!hasTestDb)("P12: Qatar numbers: Twilio numbers, forwarding from Ooredoo/Vodafone, SIP trunks", () => {
  let app: NestFastifyApplication;
  let owner: Owner;
  let agent: Awaited<ReturnType<typeof provisionAgent>>;
  const db = () => app.get(TenantDbService).db(owner.me.tenant.id);
  const call = (to: string, lines: string[], extra: Record<string, string> = {}) =>
    phoneCall(app, to, lines, undefined, { From: QA_CALLER, ...extra });

  beforeAll(async () => {
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    app = await createTestApp({
      TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
      TWILIO_API_KEY_SID: `SK${"b".repeat(32)}`,
      TWILIO_API_KEY_SECRET: "api-key-secret-0123456789",
      TWILIO_API_BASE_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
    });
    owner = await registerOwner(app, "qatar");
    const country = await owner.client.patch("/api/v1/tenant", { country: "QA", timezone: "Asia/Qatar" });
    expect(country.json()).toMatchObject({ country: "QA", callingCode: "974", currency: "QAR" });
    agent = await provisionAgent(app, owner.me.tenant.id, "clinic-reception", {
      workingHours: undefined,
      handoff: { enabled: true, phoneNumber: "+97433001122", message: "Connecting you now.", unavailableMessage: "Nobody is free. We'll call you back.", notifyEmails: [] },
    });
  });
  afterAll(async () => {
    fake.close();
    await app.close();
  });

  describe("buying a Twilio number", () => {
    let bought: { id: string; e164: string };

    it("searches and buys, pointing the number at the platform's webhooks", async () => {
      const found = (await owner.client.get("/api/v1/phone-numbers/twilio/available?country=QA&type=local")).json();
      expect(found.items[0]).toMatchObject({ phoneNumber: TW1, region: "Doha" });
      const res = await owner.client.post("/api/v1/phone-numbers/twilio/buy", { phoneNumber: TW1, agentId: agent.agentId });
      expect(res.statusCode, res.body).toBe(201);
      bought = res.json();
      expect(bought).toMatchObject({ e164: TW1, provider: "TWILIO", providerSid: expect.stringMatching(/^PN/) });
      expect(twilio.requests.find((r) => r.path === "/IncomingPhoneNumbers.json")!.body).toMatchObject({
        PhoneNumber: TW1,
        VoiceUrl: "https://voice.test/telephony/twilio/voice",
        StatusCallback: "https://voice.test/telephony/twilio/status",
      });
    });

    it("only people with billing access can buy; nobody can claim a number by typing it", async () => {
      const admin = await addMember(app, owner, "ADMIN");
      expect((await admin.client.post("/api/v1/phone-numbers/twilio/buy", { phoneNumber: TW2 })).statusCode).toBe(403);
      const typed = await owner.client.post("/api/v1/phone-numbers", { e164: "+97444990099" });
      expect(typed.statusCode).toBe(403);
      expect(typed.json().detail).toContain("Buy a number");
    });

    it("releasing gives the number back to Twilio", async () => {
      const extra = (await owner.client.post("/api/v1/phone-numbers/twilio/buy", { phoneNumber: TW2 })).json();
      const del = await owner.client.request("DELETE", `/api/v1/phone-numbers/${extra.id}?release=1`);
      expect(del.statusCode).toBe(204);
      expect(twilio.requests.at(-1)).toMatchObject({ method: "DELETE", path: `/IncomingPhoneNumbers/${extra.providerSid}.json` });
    });

    describe("the business's existing Ooredoo line, forwarded to it", () => {
      it("connects the line, typed the local way, with the codes to dial", async () => {
        const res = await owner.client.post(`/api/v1/phone-numbers/${bought.id}/forwarding`, {
          businessNumber: local(BIZ),
          carrier: "ooredoo",
          mode: "NO_ANSWER_BUSY_UNREACHABLE",
        });
        expect(res.statusCode, res.body).toBe(201);
        expect(res.json().number).toMatchObject({ forwardedFrom: `+974${BIZ}`, carrier: "ooredoo", verificationStatus: "NONE" });
        expect(res.json().instructions.mobile.enable.map((s: { code: string }) => s.code)).toEqual([
          `**61*${TW1}**20#`,
          `**67*${TW1}#`,
          `**62*${TW1}#`,
        ]);
        // The same line can't go to two agents, and the agent must not transfer to its own line
        const other = (await owner.client.post("/api/v1/phone-numbers/twilio/buy", { phoneNumber: TW3, agentId: agent.agentId })).json();
        expect((await owner.client.post(`/api/v1/phone-numbers/${other.id}/forwarding`, { businessNumber: `+974${BIZ}`, carrier: "ooredoo" })).statusCode).toBe(409);
        const loop = await owner.client.post(`/api/v1/phone-numbers/${other.id}/forwarding`, { businessNumber: "3300 1122", carrier: "vodafone_qa" });
        expect(loop.statusCode).toBe(400);
        expect(loop.json().errors[0].message).toContain("forward them straight back");
      });

      it("proves the forwarding with a test call, and records what the carrier passed", async () => {
        const v = await owner.client.post(`/api/v1/phone-numbers/${bought.id}/verify`, { from: "5512 3456" });
        expect(v.json()).toMatchObject({ verificationStatus: "PENDING" });
        const test = await call(TW1, [], { ForwardedFrom: `+974${BIZ}` });
        expect(test.last.say).toContain("Your number is connected");
        expect(test.last.hangup).toBe(true);
        const n = await db().phoneNumber.findUniqueOrThrow({ where: { id: bought.id } });
        expect(n).toMatchObject({
          verificationStatus: "VERIFIED",
          verification: { from: QA_CALLER, forwardedFrom: `+974${BIZ}`, callerIdKept: true, forwardedFromMatches: true },
        });
        // Not a customer call: nothing recorded
        expect(await db().call.count({ where: { providerCallSid: test.callSid } })).toBe(0);
      });

      it("answers forwarded customers, keeping their real number and the line they dialled", async () => {
        const c = await call(TW1, ["Priya"], { ForwardedFrom: `+974${BIZ}` });
        expect(c.replies[0]!.say).toContain("XYZ Dental Clinic");
        const record = await db().call.findUniqueOrThrow({ where: { providerCallSid: c.callSid } });
        expect(record).toMatchObject({ connection: "FORWARDED", forwardedFrom: `+974${BIZ}`, fromNumber: QA_CALLER, toNumber: `+974${BIZ}` });
        await twilioPost(app, "/telephony/twilio/status", { ...c.base, CallStatus: "completed", CallDuration: "20" });
      });

      it("never transfers a caller to the line that forwards to the agent", async () => {
        // Someone later points the agent's transfers at the business line itself
        await app.get(TenantDbService).tx(owner.me.tenant.id, async (tx) => {
          const v = await tx.agentVersion.findUniqueOrThrow({ where: { id: agent.versionId } });
          const config = v.config as { handoff: { phoneNumber: string } };
          config.handoff.phoneNumber = `+974${BIZ}`;
          await tx.agentVersion.update({ where: { id: v.id }, data: { config } });
        });
        const other = await provisionAgent(app, owner.me.tenant.id, "clinic-reception", {
          workingHours: undefined,
          handoff: { enabled: true, phoneNumber: `+974${BIZ}`, message: "Connecting you now.", unavailableMessage: "Nobody is free. We'll call you back.", notifyEmails: [] },
        });
        await db().phoneNumber.update({ where: { id: bought.id }, data: { agentId: other.agentId } });
        const c = await call(TW1, ["Kiran", "root canal", "it's an emergency"], { ForwardedFrom: `+974${BIZ}`, From: "+97455000111" });
        expect(c.last.dial).toBeNull();
        expect(c.last.say).toBe("Nobody is free. We'll call you back.");
        const handoffs = await db().callEvent.findMany({
          where: { call: { providerCallSid: c.callSid }, type: "HANDOFF" },
          orderBy: { seq: "asc" },
        });
        expect(handoffs.at(-1)!.payload).toMatchObject({ transferred: false, dialStatus: "loop_protected" });
        await db().phoneNumber.update({ where: { id: bought.id }, data: { agentId: agent.agentId } });
      });
    });
  });

  describe("SIP from Ooredoo SIP-T, Vodafone business SIP or a PBX", () => {
    let trunk: { id: string; domainName: string };
    let sipDomain = "";

    it("creates a SIP domain that only takes calls from the carrier's addresses (and a password)", async () => {
      expect(
        (await owner.client.post("/api/v1/sip-trunks", { name: "Private", carrier: "pbx", allowedIps: ["10.1.2.3"] })).json().errors[0].message,
      ).toContain("not a public IPv4");
      const res = await owner.client.post("/api/v1/sip-trunks", {
        name: "Ooredoo SIP-T",
        carrier: "ooredoo",
        allowedIps: ["212.77.192.0/24"],
        useCredentials: true,
      });
      expect(res.statusCode, res.body).toBe(201);
      const body = res.json();
      trunk = body.trunk;
      sipDomain = body.sipDomain;
      expect(body.trunk).toMatchObject({ status: "ACTIVE", allowedIps: ["212.77.192.0/24"], authUsername: expect.any(String) });
      expect(sipDomain).toBe(`${trunk.domainName}.sip.twilio.com`);
      expect(body.password).toMatch(/^[A-Za-z0-9]{14,}$/);
      const paths = twilio.requests.map((r) => `${r.method} ${r.path}`);
      expect(paths).toEqual(
        expect.arrayContaining([
          "POST /SIP/Domains.json",
          "POST /SIP/IpAccessControlLists.json",
          expect.stringMatching(/^POST \/SIP\/Domains\/SD\d+\/Auth\/Calls\/IpAccessControlListMappings\.json$/),
          expect.stringMatching(/^POST \/SIP\/Domains\/SD\d+\/Auth\/Calls\/CredentialListMappings\.json$/),
        ]),
      );
      expect(twilio.requests.find((r) => r.path === "/SIP/Domains.json")!.body).toMatchObject({
        DomainName: sipDomain,
        VoiceUrl: "https://voice.test/telephony/twilio/voice",
      });
      // The password is never readable again
      expect(JSON.stringify((await owner.client.get("/api/v1/sip-trunks")).json())).not.toContain(body.password);
    });

    it("answers calls to the business's numbers on the trunk, local or international format", async () => {
      const n = await owner.client.post(`/api/v1/sip-trunks/${trunk.id}/numbers`, { number: local(SIPN), agentId: agent.agentId });
      expect(n.statusCode, n.body).toBe(201);
      expect(n.json()).toMatchObject({ e164: `+974${SIPN}`, provider: "SIP" });
      for (const to of [`sip:+974${SIPN}@${sipDomain}`, `sip:${SIPN}@${sipDomain};transport=tls`]) {
        const c = await call(to, [], { From: "sip:+97466778899@212.77.192.10" });
        expect(c.replies[0]!.say).toContain("XYZ Dental Clinic");
        const record = await db().call.findUniqueOrThrow({ where: { providerCallSid: c.callSid } });
        expect(record).toMatchObject({ connection: "SIP", fromNumber: "+97466778899", toNumber: `+974${SIPN}` });
        await twilioPost(app, "/telephony/twilio/status", { ...c.base, CallStatus: "completed", CallDuration: "10" });
      }
      // Another domain, or a number not on this trunk, reaches nobody
      expect((await call(`sip:+974${SIPN}@other-123456.sip.twilio.com`, [])).last.say).toContain("not in service");
      expect((await call(`sip:+97444009999@${sipDomain}`, [])).last.say).toContain("not in service");
      expect((await db().sipTrunk.findUniqueOrThrow({ where: { id: trunk.id } })).lastCallAt).not.toBeNull();
    });

    it("gives the carrier a setup sheet, and keeps connections with numbers", async () => {
      const sheet = (await owner.client.get(`/api/v1/sip-trunks/${trunk.id}/setup-sheet`)).json();
      expect(sheet.uris).toEqual([`sip:+974${SIPN}@${sipDomain}`]);
      expect(sheet.text).toContain("G.711 A-law");
      expect((await owner.client.request("DELETE", `/api/v1/sip-trunks/${trunk.id}`)).statusCode).toBe(409);
      const outsider = await registerOwner(app, "qatar-outsider");
      expect((await outsider.client.get("/api/v1/sip-trunks")).json().items).toEqual([]);
      expect((await outsider.client.get(`/api/v1/sip-trunks/${trunk.id}/setup-sheet`)).statusCode).toBe(404);
    });
  });

  describe("abuse and cost controls", () => {
    let number = "";
    beforeAll(async () => {
      number = (await provisionAgent(app, owner.me.tenant.id, "clinic-reception", { workingHours: undefined })).e164;
    });

    it("refuses blocked callers and ranges before answering", async () => {
      expect((await owner.client.post("/api/v1/blocked-callers", { pattern: "+88216*", reason: "satellite toll fraud" })).statusCode).toBe(201);
      const c = await call(number, [], { From: "+882160000001" });
      expect(c.last.xml).toContain('<Reject reason="rejected"/>');
      expect((await owner.client.post("/api/v1/blocked-callers", { pattern: "12345" })).statusCode).toBe(400);
    });

    it("caps simultaneous calls on a number", async () => {
      const row = await db().phoneNumber.findFirstOrThrow({ where: { e164: number } });
      await owner.client.patch(`/api/v1/phone-numbers/${row.id}`, { maxConcurrentCalls: 1 });
      const first = await call(number, [], { From: "+97455000001" });
      const second = await call(number, [], { From: "+97455000002" });
      expect(second.last.xml).toContain('<Reject reason="busy"/>');
      await twilioPost(app, "/telephony/twilio/status", { ...first.base, CallStatus: "completed", CallDuration: "5" });
      const third = await call(number, [], { From: "+97455000003" });
      expect(third.last.say).toContain("XYZ Dental Clinic");
      await twilioPost(app, "/telephony/twilio/status", { ...third.base, CallStatus: "completed", CallDuration: "5" });
      await owner.client.patch(`/api/v1/phone-numbers/${row.id}`, { maxConcurrentCalls: null });
    });

    it("ends calls politely at the business's time limit", async () => {
      const c = await call(number, ["Leela"], { From: "+97455000004" });
      const redis = app.get(RedisService).client;
      const state = JSON.parse((await redis.get(`callstate:${c.callSid}`))!);
      state.startedAt = Date.now() - 21 * 60_000;
      await redis.set(`callstate:${c.callSid}`, JSON.stringify(state));
      const next = await twilioPost(app, c.last.next!, { ...c.base, SpeechResult: "cleaning" });
      expect(next.twiml.say).toContain("time limit for this call");
      expect(next.twiml.hangup).toBe(true);
      const ended = await db().callEvent.findFirstOrThrow({ where: { call: { providerCallSid: c.callSid }, type: "CALL_ENDED" } });
      expect(ended.payload).toMatchObject({ reason: "max_duration" });
    });

    it("refuses calls past the plan's daily limit and tells the owner", async () => {
      const used = await db().call.count();
      await db().tenant.update({ where: { id: owner.me.tenant.id }, data: { usageLimits: { maxCallsPerDay: used } } });
      // Settings are cached for 30 s per instance: a fresh app reads them now
      const fresh = await createTestApp();
      try {
        const c = await phoneCall(fresh, number, [], undefined, { From: "+97455000005" });
        expect(c.last.say).toContain("can't take calls on this line right now");
        const alerts = (await owner.client.get("/api/v1/alerts")).json().items;
        expect(alerts[0]).toMatchObject({ kind: "usage_limit", message: expect.stringContaining(`allows ${used} calls`) });
        expect((await owner.client.post(`/api/v1/alerts/${alerts[0].id}/acknowledge`)).statusCode).toBe(204);
        expect((await owner.client.get("/api/v1/alerts")).json().items).toEqual([]);
      } finally {
        await fresh.close();
        await db().tenant.update({ where: { id: owner.me.tenant.id }, data: { usageLimits: {} } });
      }
    });
  });
});
