import { type NestFastifyApplication } from "@nestjs/platform-fastify";
import { zonedDateTimeToUtc } from "@platform/core";
import { generateKeyPairSync } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../src/infra/prisma.service";
import { TenantDbService } from "../src/infra/tenant-db.service";
import { addMember, createTestApp, hasTestDb, registerOwner } from "./support/app";
import { DEFAULT_CALLER, phoneCall, provisionAgent, twilioPost } from "./support/telephony";

type Owner = Awaited<ReturnType<typeof registerOwner>>;

// ── Local stand-ins for the outside world ───────────────────────────────────
const hooks: { headers: http.IncomingHttpHeaders; body: string }[] = [];
let hookStatus = 200;
const hookServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    hooks.push({ headers: req.headers, body });
    res.writeHead(hookStatus).end();
  });
});
const mails: { to: string[]; data: string }[] = [];
const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ["STARTTLS"],
  onAuth(auth, _session, cb) {
    if (auth.username === "bot" && auth.password === "smtp-Pa55word-xyz") cb(null, { user: "bot" });
    else cb(new Error("Invalid username or password"));
  },
  onData(stream, session, cb) {
    let data = "";
    stream.on("data", (c: Buffer) => (data += c.toString()));
    stream.on("end", () => {
      mails.push({ to: session.envelope.rcptTo.map((r) => r.address), data });
      cb();
    });
  },
});

/** Fake Google APIs behind the global fetch; other requests go to the network as usual */
type GoogleCall = { method: string; url: URL; body: string };
const google: { calls: GoogleCall[]; busy: { start: string; end: string }[]; fail?: number } = {
  calls: [],
  busy: [],
};
const realFetch = globalThis.fetch;
function installFakeGoogle() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (!url.hostname.endsWith("googleapis.com")) return realFetch(input, init);
    const call = {
      method: init.method ?? "GET",
      url,
      body: typeof init.body === "string" ? init.body : String(init.body ?? ""),
    };
    google.calls.push(call);
    if (url.hostname === "oauth2.googleapis.com")
      return Response.json({ access_token: "ya29.fake", expires_in: 3600 });
    if (google.fail)
      return Response.json({ error: { message: "Invalid Credentials" } }, { status: google.fail });
    if (call.method === "GET" && url.pathname.endsWith("/events"))
      return Response.json({
        items: google.busy.map((b, i) => ({
          id: `e${i}`,
          status: "confirmed",
          start: { dateTime: b.start },
          end: { dateTime: b.end },
        })),
      });
    if (call.method === "GET") return Response.json({ summary: "Front desk" });
    if (call.method === "POST") return Response.json({ id: JSON.parse(call.body).id });
    if (call.method === "PATCH") return Response.json({ id: "moved" });
    return new Response(null, { status: 204 });
  });
}

const serviceAccountJson = () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return JSON.stringify({
    type: "service_account",
    client_email: "agent@clinic-project.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });
};

/** Tomorrow's date in India (calls say "tomorrow") */
const tomorrowIST = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() + 86_400_000));

describe.skipIf(!hasTestDb)("P9: integrations, tools, appointments and handoff", () => {
  let app: NestFastifyApplication;
  let owner: Owner;
  let hookUrl = "";
  let smtpPort = 0;
  const secrets: string[] = [];

  beforeAll(async () => {
    await new Promise<void>((r) => hookServer.listen(0, "127.0.0.1", r));
    hookUrl = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/calls`;
    await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
    smtpPort = (smtp.server.address() as AddressInfo).port;
    installFakeGoogle();
    app = await createTestApp();
    owner = await registerOwner(app, "p9");
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    hookServer.close();
    await new Promise<void>((r) => smtp.close(() => r()));
    await app.close();
  });

  const db = () => app.get(TenantDbService).db(owner.me.tenant.id);
  const createIntegration = async (body: Record<string, unknown>, o: Owner = owner) => {
    const res = await o.client.post("/api/v1/integrations", body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  };
  const bind = (agentId: string, bindings: { toolName: string; integrationId: string | null }[]) =>
    owner.client.request("PUT", `/api/v1/agents/${agentId}/tool-bindings`, { bindings });

  describe("integrations API", () => {
    it("stores credentials encrypted and never returns them", async () => {
      const sa = serviceAccountJson();
      const cal = await createIntegration({
        type: "GOOGLE_CALENDAR",
        name: "Clinic calendar",
        config: { calendarId: "frontdesk@clinic.test" },
        credentials: { kind: "service_account", json: sa },
      });
      const mail = await createIntegration({
        type: "EMAIL_SMTP",
        name: "Clinic mail",
        config: { from: "agent@clinic.test", defaultTo: ["frontdesk@clinic.test"] },
        credentials: {
          host: "127.0.0.1",
          port: smtpPort,
          secure: false,
          username: "bot",
          password: "smtp-Pa55word-xyz",
        },
      });
      const hook = await createIntegration({ type: "WEBHOOK", name: "CRM hook", config: { url: hookUrl } });
      secrets.push(JSON.parse(sa).private_key.split("\n")[1], "smtp-Pa55word-xyz", hook.signingSecret);

      // The webhook signing secret is shown exactly once, at creation
      expect(hook.signingSecret).toMatch(/^whsec_/);
      expect(cal.config).toEqual({
        calendarId: "frontdesk@clinic.test",
        account: "agent@clinic-project.iam.gserviceaccount.com",
      });
      expect(mail.config).toMatchObject({ host: "127.0.0.1" });

      const responses = [
        JSON.stringify(cal),
        JSON.stringify(mail),
        (await owner.client.get("/api/v1/integrations")).body,
        (await owner.client.patch(`/api/v1/integrations/${mail.id}`, { name: "Front desk mail" })).body,
        (await owner.client.post(`/api/v1/integrations/${hook.id}/test`)).body,
        (await owner.client.get("/api/v1/audit-logs")).body,
      ];
      for (const body of responses) {
        for (const secret of secrets) expect(body).not.toContain(secret);
        // Secret fields never appear, not even as empty keys
        expect(body).not.toMatch(
          /"(credentials|credentialsEncrypted|privateKey|private_key|password|secret)"/,
        );
      }
      // And the database holds ciphertext only
      const raw = await app.get(PrismaService).client.$queryRaw<
        { c: Buffer }[]
      >`SELECT credentials_encrypted AS c FROM integrations WHERE id = ${mail.id}::uuid`;
      expect(raw).toEqual([]); // RLS: the app role sees nothing without a tenant
      const row = await db().integration.findUniqueOrThrow({ where: { id: mail.id } });
      expect(Buffer.from(row.credentialsEncrypted).toString("latin1")).not.toContain("smtp-Pa55word-xyz");
    });

    it("validates settings per type", async () => {
      const bad = await owner.client.post("/api/v1/integrations", {
        type: "GOOGLE_SHEETS",
        name: "Sheet",
        config: { spreadsheetId: "short" },
        credentials: { kind: "service_account", json: "{}" },
      });
      expect(bad.statusCode).toBe(400);
      expect(
        bad
          .json()
          .errors.map((e: { path: string }) => e.path)
          .sort(),
      ).toEqual(["config.spreadsheetId", "credentials.json"]);
      expect(
        (
          await owner.client.post("/api/v1/integrations", {
            type: "WEBHOOK",
            name: "CRM hook",
            config: { url: hookUrl },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await owner.client.post("/api/v1/integrations", {
            type: "HUBSPOT",
            name: "CRM",
            config: {},
            credentials: {},
          })
        ).statusCode,
      ).toBe(400);
    });

    it("tests connections for real and records failures for staff", async () => {
      const list = (await owner.client.get("/api/v1/integrations")).json().items as {
        id: string;
        type: string;
        name: string;
      }[];
      const hook = list.find((i) => i.type === "WEBHOOK")!;
      hooks.length = 0;
      expect((await owner.client.post(`/api/v1/integrations/${hook.id}/test`)).json()).toEqual({
        ok: true,
        message: "Your endpoint answered 200",
      });
      expect(JSON.parse(hooks[0]!.body)).toMatchObject({ event: "ping" });

      hookStatus = 500;
      expect((await owner.client.post(`/api/v1/integrations/${hook.id}/test`)).json()).toEqual({
        ok: false,
        message: "Webhook answered 500",
      });
      hookStatus = 200;
      const after = (await owner.client.get("/api/v1/integrations"))
        .json()
        .items.find((i: { id: string }) => i.id === hook.id);
      expect(after).toMatchObject({ status: "ERROR", lastError: "Webhook answered 500" });

      const cal = list.find((i) => i.type === "GOOGLE_CALENDAR")!;
      expect((await owner.client.post(`/api/v1/integrations/${cal.id}/test`)).json()).toEqual({
        ok: true,
        message: 'Connected to calendar "Front desk"',
      });
      const mail = list.find((i) => i.type === "EMAIL_SMTP")!;
      expect((await owner.client.post(`/api/v1/integrations/${mail.id}/test`)).json()).toEqual({
        ok: true,
        message: "Logged in to the mail server",
      });
    });

    it("keeps integrations private to the business and writable only by admins", async () => {
      const outsider = await registerOwner(app, "p9-outsider");
      const mine = (await owner.client.get("/api/v1/integrations")).json().items[0];
      expect((await outsider.client.get("/api/v1/integrations")).json().items).toEqual([]);
      expect((await outsider.client.post(`/api/v1/integrations/${mine.id}/test`)).statusCode).toBe(404);
      expect((await outsider.client.delete(`/api/v1/integrations/${mine.id}`)).statusCode).toBe(404);
      const manager = await addMember(app, owner, "MANAGER");
      expect((await manager.client.get("/api/v1/integrations")).statusCode).toBe(200);
      expect(
        (
          await manager.client.post("/api/v1/integrations", {
            type: "WEBHOOK",
            name: "x hook",
            config: { url: hookUrl },
          })
        ).statusCode,
      ).toBe(403);
      expect((await manager.client.post(`/api/v1/integrations/${mine.id}/test`)).statusCode).toBe(403);
    });

    it("Connect with Google is refused when the platform has no OAuth client", async () => {
      const res = await owner.client.get(
        "/api/v1/integrations/oauth/google/start?type=GOOGLE_CALENDAR&name=Cal",
      );
      expect(res.statusCode).toBe(409);
      // A callback without the browser binding never creates anything
      const cb = await app.inject({
        method: "GET",
        url: "/api/v1/integrations/oauth/google/callback?state=forged&code=abc",
      });
      expect(cb.statusCode).toBe(302);
      expect(cb.headers.location).toMatch(/\/login$/);
    });
  });

  describe("tools on real calls", () => {
    const integrationOf = async (type: string) =>
      ((await owner.client.get("/api/v1/integrations")).json().items as { id: string; type: string }[]).find(
        (i) => i.type === type,
      )!.id;

    it("binds tools only to integrations of the right kind, and publishing checks it", async () => {
      const agentId = (
        await owner.client.post("/api/v1/agents", { name: "Front desk", templateKey: "clinic-reception" })
      ).json().id;
      const draft = (await owner.client.get(`/api/v1/agents/${agentId}`)).json().draft.config;
      draft.tools.push("webhook.post");
      expect(
        (await owner.client.request("PUT", `/api/v1/agents/${agentId}/draft`, { config: draft })).statusCode,
      ).toBe(200);
      const blocked = await owner.client.post(`/api/v1/agents/${agentId}/publish`);
      expect(blocked.json().errors).toEqual([
        { path: "config.tools.2", message: 'Connect a webhook and choose it for "Call a webhook"' },
      ]);

      const wrong = await bind(agentId, [
        { toolName: "webhook.post", integrationId: await integrationOf("EMAIL_SMTP") },
      ]);
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().errors[0].message).toContain("can't run Call a webhook");
      const ok = await bind(agentId, [
        { toolName: "webhook.post", integrationId: await integrationOf("WEBHOOK") },
      ]);
      expect(ok.json().items).toEqual([
        expect.objectContaining({
          toolName: "webhook.post",
          integration: expect.objectContaining({ type: "WEBHOOK" }),
        }),
      ]);
      expect((await owner.client.post(`/api/v1/agents/${agentId}/publish`)).statusCode).toBe(201);
    });

    it("books into Google Calendar during a call, offering other times when taken", async () => {
      const calendarId = await integrationOf("GOOGLE_CALENDAR");
      const clinic = await provisionAgent(app, owner.me.tenant.id, "clinic-reception", {
        workingHours: undefined,
      });
      // Swap the platform booking for the calendar one
      const config = clinic.config;
      config.tools = ["leads.create", "calendar.book"];
      const book = config.workflow.steps.find((s) => s.id === "book")!;
      if (book.type === "confirm_and_act") book.action = "calendar.book";
      await app
        .get(TenantDbService)
        .db(owner.me.tenant.id)
        .agentVersion.update({ where: { id: clinic.versionId }, data: { config } });
      await bind(clinic.agentId, [{ toolName: "calendar.book", integrationId: calendarId }]);

      const day = tomorrowIST();
      google.busy = [
        {
          start: zonedDateTimeToUtc(day, "10:00", "Asia/Kolkata").toISOString(),
          end: zonedDateTimeToUtc(day, "10:30", "Asia/Kolkata").toISOString(),
        },
      ];
      google.calls.length = 0;
      const call = await phoneCall(app, clinic.e164, [
        "Priya",
        "cleaning",
        "flexible",
        "tomorrow",
        "10 am",
        "yes",
        "11 am",
        "yes",
      ]);
      const says = call.replies.map((r) => r.say);
      expect(says).toContainEqual(
        expect.stringMatching(
          /^10 AM on \w+, \d+ \w+ is already booked\. On \w+, \d+ \w+ I have 9:30 AM or 10:30 AM free\. What time suits you\?$/,
        ),
      );
      expect(call.last.say).toContain("Your appointment is confirmed");

      const inserted = google.calls.filter((c) => c.method === "POST" && c.url.pathname.endsWith("/events"));
      expect(inserted).toHaveLength(1);
      expect(inserted[0]!.url.pathname).toBe("/calendar/v3/calendars/frontdesk%40clinic.test/events");
      const event = JSON.parse(inserted[0]!.body);
      expect(event.start).toEqual({
        dateTime: zonedDateTimeToUtc(day, "11:00", "Asia/Kolkata").toISOString(),
        timeZone: "Asia/Kolkata",
      });

      const record = await db().call.findUniqueOrThrow({
        where: { providerCallSid: call.callSid },
        include: { appointments: true, events: { where: { type: "TOOL_CALL" }, orderBy: { seq: "asc" } } },
      });
      expect(record.outcome).toBe("APPOINTMENT_BOOKED");
      expect(record.appointments).toEqual([
        expect.objectContaining({ externalRef: event.id, integrationId: calendarId, status: "UPCOMING" }),
      ]);
      const executed = record.events
        .filter((e) => (e.payload as { phase?: string }).phase === "executed")
        .map((e) => e.payload);
      expect(executed).toEqual([
        expect.objectContaining({
          tool: "calendar.book",
          ok: false,
          error: "slot_unavailable",
          integrationId: calendarId,
        }),
        expect.objectContaining({ tool: "calendar.book", ok: true, attempts: 1 }),
      ]);
    });

    it("reschedules and cancels appointments, keeping the calendar in step", async () => {
      const appt = (await owner.client.get("/api/v1/appointments?status=UPCOMING"))
        .json()
        .items.find((a: { externalRef: string | null }) => a.externalRef);
      expect(appt).toMatchObject({
        lead: { customerName: "Priya" },
        integration: { type: "GOOGLE_CALENDAR" },
      });
      google.calls.length = 0;
      const day = tomorrowIST();
      const moved = await owner.client.patch(`/api/v1/appointments/${appt.id}`, {
        reschedule: { date: day, time: "15:00" },
      });
      expect(moved.statusCode).toBe(200);
      expect(moved.json()).toMatchObject({
        status: "UPCOMING",
        rescheduledFromId: appt.id,
        externalRef: appt.externalRef,
      });
      expect(google.calls.find((c) => c.method === "PATCH")!.url.pathname).toMatch(
        new RegExp(`/events/${appt.externalRef}$`),
      );
      expect((await owner.client.get(`/api/v1/appointments/${appt.id}`)).json().status).toBe("RESCHEDULED");

      const cancelled = await owner.client.patch(`/api/v1/appointments/${moved.json().id}`, {
        status: "CANCELLED",
      });
      expect(cancelled.json().status).toBe("CANCELLED");
      expect(google.calls.some((c) => c.method === "DELETE")).toBe(true);
      expect(
        (
          await owner.client.patch(`/api/v1/appointments/${moved.json().id}`, {
            reschedule: { date: day, time: "16:00" },
          })
        ).statusCode,
      ).toBe(409);
    });

    it("a revoked calendar fails the change clearly and flags the integration", async () => {
      const clinicAppt = await db().appointment.findFirstOrThrow({
        where: { status: "CANCELLED", externalRef: { not: null } },
      });
      const fresh = await db().appointment.create({
        data: {
          ...clinicAppt,
          id: undefined,
          status: "UPCOMING",
          startsAt: new Date(Date.now() + 2 * 86_400_000),
          endsAt: new Date(Date.now() + 2 * 86_400_000 + 1_800_000),
          createdAt: undefined,
          updatedAt: undefined,
          rescheduledFromId: null,
        } as never,
      });
      google.fail = 401;
      const res = await owner.client.patch(`/api/v1/appointments/${fresh.id}`, { status: "CANCELLED" });
      google.fail = undefined;
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ code: "INTEGRATION_ERROR" });
      expect((await db().appointment.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe("UPCOMING");
      const cal = await db().integration.findUniqueOrThrow({ where: { id: fresh.integrationId! } });
      expect(cal.status).toBe("ERROR");
    });

    it("platform bookings respect capacity across concurrent callers", async () => {
      const clinic = await provisionAgent(app, owner.me.tenant.id, "clinic-reception", {
        workingHours: undefined,
      });
      const lines = (name: string) => [name, "cleaning", "flexible", "tomorrow", "4 pm", "yes"];
      const [a, b] = await Promise.all([
        phoneCall(app, clinic.e164, lines("Priya")),
        phoneCall(app, clinic.e164, lines("Arjun"), undefined, { From: "+919800000001" }),
      ]);
      const outcomes = [a, b].map((c) => c.last.say);
      expect(outcomes.filter((s) => s.includes("Your appointment is confirmed"))).toHaveLength(1);
      expect(
        outcomes.filter((s) => /is already booked\. On .* I have .* free\. What time suits you\?/.test(s)),
      ).toHaveLength(1);
      const booked = await db().appointment.count({ where: { agentId: clinic.agentId, status: "UPCOMING" } });
      expect(booked).toBe(1);
    });

    it("an unanswered transfer: whisper, then a message, follow-up lead and staff email", async () => {
      const clinic = await provisionAgent(app, owner.me.tenant.id, "clinic-reception", {
        workingHours: undefined,
        handoff: {
          enabled: true,
          phoneNumber: "+911140000099",
          message: "Connecting you now.",
          unavailableMessage: "Sorry {{patient_name}}, nobody is free. We'll call you back.",
          notifyEmails: ["owner@clinic.test"],
        },
      });
      mails.length = 0;
      const call = await phoneCall(app, clinic.e164, ["Priya", "root canal", "it's an emergency"]);
      expect(call.last.dial).toBe("+911140000099");
      expect(call.last.xml).toContain(
        `url="https://voice.test/telephony/twilio/whisper?sid=${call.callSid}"`,
      );

      const whisper = await twilioPost(app, `/telephony/twilio/whisper?sid=${call.callSid}`, {
        CallSid: "CAchild",
        ParentCallSid: call.callSid,
      });
      expect(whisper.twiml.say).toBe(
        "Transferred call from Maya, the XYZ Dental Clinic assistant. Reason: Emergency. Patient name: Priya. Service: Root canal. Urgency: Emergency.",
      );
      expect(whisper.twiml.hangup).toBe(false);

      const dial = await twilioPost(app, "/telephony/twilio/dial-status", {
        ...call.base,
        DialCallStatus: "no-answer",
      });
      expect(dial.twiml.say).toBe("Sorry Priya, nobody is free. We'll call you back.");
      expect(dial.twiml.hangup).toBe(true);
      // Twilio retrying the same callback changes nothing twice
      await twilioPost(app, "/telephony/twilio/dial-status", { ...call.base, DialCallStatus: "no-answer" });

      const record = await db().call.findUniqueOrThrow({
        where: { providerCallSid: call.callSid },
        include: { events: { where: { type: "HANDOFF" } } },
      });
      expect(record.outcome).toBe("FOLLOW_UP_REQUIRED");
      // Same caller and name earlier today: their existing lead is updated rather than duplicated
      const lead = await db().lead.findFirstOrThrow({
        where: { phone: DEFAULT_CALLER, customerName: "Priya" },
        orderBy: { updatedAt: "desc" },
      });
      expect(lead.data).toMatchObject({ urgency: "Emergency", service_required: "Root canal" });
      expect(record.events.map((e) => e.payload)).toEqual([
        expect.objectContaining({ transferred: true }),
        expect.objectContaining({ transferred: false, dialStatus: "no-answer" }),
      ]);
      await vi.waitFor(() => expect(mails).toHaveLength(1));
      expect(mails[0]!.to).toEqual(["owner@clinic.test"]);
      expect(mails[0]!.data).toContain(`Missed transfer: please call back ${DEFAULT_CALLER}`);
      expect(mails[0]!.data).toContain("Patient name: Priya");
    });

    it("an answered transfer simply ends the call", async () => {
      const clinic = await provisionAgent(app, owner.me.tenant.id, "clinic-reception", {
        workingHours: undefined,
      });
      const call = await phoneCall(app, clinic.e164, ["can I speak to a person"]);
      const dial = await twilioPost(app, "/telephony/twilio/dial-status", {
        ...call.base,
        DialCallStatus: "completed",
      });
      expect(dial.twiml).toMatchObject({ say: "", hangup: true });
      const record = await db().call.findUniqueOrThrow({ where: { providerCallSid: call.callSid } });
      expect(record.outcome).toBe("HUMAN_HANDOFF");
    });
  });

  describe("lead statuses", () => {
    it("deletes a status only after its leads have somewhere to go", async () => {
      const statuses = (await owner.client.get("/api/v1/lead-statuses")).json().items as {
        id: string;
        key: string;
        isDefault: boolean;
      }[];
      const def = statuses.find((s) => s.isDefault)!;
      expect((await owner.client.delete(`/api/v1/lead-statuses/${def.id}`)).statusCode).toBe(409);
      const extra = (await owner.client.post("/api/v1/lead-statuses", { key: "vip", label: "VIP" })).json();
      const lead = await db().lead.findFirstOrThrow();
      await db().lead.update({ where: { id: lead.id }, data: { statusId: extra.id } });
      expect((await owner.client.delete(`/api/v1/lead-statuses/${extra.id}`)).statusCode).toBe(409);
      expect(
        (await owner.client.delete(`/api/v1/lead-statuses/${extra.id}?moveTo=${def.id}`)).statusCode,
      ).toBe(204);
      expect((await db().lead.findUniqueOrThrow({ where: { id: lead.id } })).statusId).toBe(def.id);
    });
  });
});
