import { type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantDbService } from "../src/infra/tenant-db.service";
import { Client, createTestApp, hasTestDb, registerOwner, STRONG_PASSWORD, uniqueEmail } from "./support/app";
import { phoneCall, provisionAgent, twilioPost } from "./support/telephony";

describe.skipIf(!hasTestDb)("telephony: real phone calls through Twilio webhooks", () => {
  let app: NestFastifyApplication;
  let owner: Awaited<ReturnType<typeof registerOwner>>;
  let clinic: Awaited<ReturnType<typeof provisionAgent>>;
  const db = () => app.get(TenantDbService).db(owner.me.tenant.id);

  beforeAll(async () => {
    app = await createTestApp();
    owner = await registerOwner(app, "tel");
    // Always open, so the test does not depend on the time of day
    clinic = await provisionAgent(app, owner.me.tenant.id, "clinic-reception", { workingHours: undefined });
  });
  afterAll(() => app.close());

  it("rejects webhooks without a valid Twilio signature", async () => {
    const params = { CallSid: "CAfake", From: "+911", To: clinic.e164, CallStatus: "ringing" };
    expect(
      (await twilioPost(app, "/telephony/twilio/voice", params, { signature: null })).res.statusCode,
    ).toBe(403);
    expect(
      (await twilioPost(app, "/telephony/twilio/voice", params, { token: "wrong-token-000000000000" })).res
        .statusCode,
    ).toBe(403);
  });

  it("politely hangs up on numbers without an active agent", async () => {
    const { last } = await phoneCall(app, "+10000000000", []);
    expect(last.status).toBe(200);
    expect(last.say).toContain("not in service");
    expect(last.hangup).toBe(true);
  });

  it("books an appointment end to end and records everything", async () => {
    const call = await phoneCall(app, clinic.e164, [
      "Priya",
      "cleaning",
      "my number is 98765 43210 and I'm flexible",
      "tomorrow",
      "10 am",
      "yes",
    ]);
    expect(call.replies[0]!.say).toBe(
      "Hello, you've reached XYZ Dental Clinic. I'm Maya, and I can help you book an appointment. May I have the patient's name?",
    );
    expect(call.replies[0]!.xml).toContain('<Gather input="speech"');
    expect(call.last.hangup).toBe(true);
    expect(call.last.say).toContain("Your appointment is confirmed");

    const record = await db().call.findUniqueOrThrow({
      where: { providerCallSid: call.callSid },
      include: { appointments: true, leads: true },
    });
    expect(record).toMatchObject({
      outcome: "APPOINTMENT_BOOKED",
      qualificationStatus: "QUALIFIED",
      totalTurns: 6,
      status: "IN_PROGRESS",
    });
    expect(record.appointments).toHaveLength(1);
    const hourInIndia = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      hour12: false,
    }).format(record.appointments[0]!.startsAt);
    expect(hourInIndia).toBe("10");
    expect(record.leads[0]).toMatchObject({ customerName: "Priya", phone: "+919812345678" });
    expect(record.leads[0]!.data).toMatchObject({ service_required: "Dental cleaning", urgency: "Flexible" });

    const events = await db().callEvent.findMany({ where: { callId: record.id }, orderBy: { seq: "asc" } });
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("CALL_STARTED");
    expect(types).toEqual(
      expect.arrayContaining(["USER_TURN", "AGENT_TURN", "EXTRACTION", "TOOL_CALL", "CALL_ENDED"]),
    );
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    // Personal data is redacted in the stored transcript
    const said = events
      .filter((e) => e.type === "USER_TURN")
      .map((e) => (e.payload as { text: string }).text);
    expect(said).toContain("my number is [PHONE] and I'm flexible");

    // Twilio's final status callback
    const status = await twilioPost(app, "/telephony/twilio/status", {
      ...call.base,
      CallStatus: "completed",
      CallDuration: "95",
    });
    expect(status.res.statusCode).toBe(204);
    const done = await db().call.findUniqueOrThrow({ where: { id: record.id } });
    expect(done).toMatchObject({ status: "COMPLETED", durationSec: 95 });
    const minutes = await db().usageRecord.findFirstOrThrow({
      where: { callId: record.id, kind: "TELEPHONY_MINUTES" },
    });
    expect(minutes.quantity).toBe(2n);
  });

  it("never confirms an appointment outside working hours", async () => {
    const hours = {
      timezone: "Asia/Kolkata",
      days: { mon: [{ start: "09:00", end: "10:00" }] },
      offHours: "normal" as const,
    };
    const narrow = await provisionAgent(app, owner.me.tenant.id, "clinic-reception", { workingHours: hours });
    // Any date that is not a Monday, or a Monday at 4 pm, is closed
    const call = await phoneCall(app, narrow.e164, [
      "Priya",
      "cleaning",
      "flexible",
      "next sunday",
      "4 pm",
      "yes",
    ]);
    // The caller hears why, and is asked for another day (instead of a generic failure)
    expect(call.last.say).toMatch(
      /^We're closed at 4 PM on Sunday, \d+ \w+\. I don't have any free times that day\. Which day/,
    );
    expect(call.last.say).not.toContain("confirmed");
    expect(call.last.hangup).toBe(false);
    const record = await db().call.findUniqueOrThrow({
      where: { providerCallSid: call.callSid },
      include: { appointments: true },
    });
    expect(record.appointments).toHaveLength(0);
    expect(record.outcome).not.toBe("APPOINTMENT_BOOKED");
  });

  it("replays the same reply when Twilio retries a webhook", async () => {
    const call = await phoneCall(app, clinic.e164, ["Priya"]);
    const next = call.last.next!;
    const first = await twilioPost(app, next, { ...call.base, SpeechResult: "cleaning" });
    const retry = await twilioPost(app, next, { ...call.base, SpeechResult: "cleaning" });
    expect(retry.twiml.xml).toBe(first.twiml.xml);
    const record = await db().call.findUniqueOrThrow({ where: { providerCallSid: call.callSid } });
    expect(record.totalTurns).toBe(2);
    const userTurns = await db().callEvent.count({ where: { callId: record.id, type: "USER_TURN" } });
    expect(userTurns).toBe(2);
  });

  it("re-prompts on silence", async () => {
    const call = await phoneCall(app, clinic.e164, [""]);
    expect(call.last.say).toBe("Sorry, I didn't catch that. May I have the patient's name?");
  });

  it("transfers emergencies to the front desk", async () => {
    const call = await phoneCall(app, clinic.e164, ["Priya", "root canal", "it's an emergency"]);
    expect(call.last.dial).toBe("+911140000099");
    const record = await db().call.findUniqueOrThrow({ where: { providerCallSid: call.callSid } });
    expect(record.outcome).toBe("HUMAN_HANDOFF");
  });

  it("keeps what was collected when the caller hangs up mid-call", async () => {
    const call = await phoneCall(app, clinic.e164, ["Arjun", "braces"]);
    await twilioPost(app, "/telephony/twilio/status", {
      ...call.base,
      CallStatus: "completed",
      CallDuration: "30",
    });
    const record = await db().call.findUniqueOrThrow({
      where: { providerCallSid: call.callSid },
      include: { leads: true },
    });
    expect(record).toMatchObject({ status: "COMPLETED", qualificationStatus: "PARTIAL" });
    expect(record.leads[0]).toMatchObject({
      customerName: "Arjun",
      data: { patient_name: "Arjun", service_required: "Braces" },
    });
    const ended = await db().callEvent.findFirstOrThrow({ where: { callId: record.id, type: "CALL_ENDED" } });
    expect(ended.payload).toMatchObject({ reason: "caller_hung_up" });
  });

  it("merges a repeat call from the same person into one lead, but not a different person on the same phone", async () => {
    const from = { From: "+919800000321" };
    const a = await phoneCall(app, clinic.e164, ["Ravi Kumar", "cleaning"], undefined, from);
    await twilioPost(app, "/telephony/twilio/status", {
      ...a.base,
      CallStatus: "completed",
      CallDuration: "20",
    });
    const b = await phoneCall(app, clinic.e164, ["Ravi Kumar", "cleaning", "flexible"], undefined, from);
    await twilioPost(app, "/telephony/twilio/status", {
      ...b.base,
      CallStatus: "completed",
      CallDuration: "20",
    });
    const c = await phoneCall(app, clinic.e164, ["Sita Kumar", "braces"], undefined, from);
    await twilioPost(app, "/telephony/twilio/status", {
      ...c.base,
      CallStatus: "completed",
      CallDuration: "20",
    });

    const leads = await db().lead.findMany({
      where: { phone: "+919800000321" },
      orderBy: { createdAt: "asc" },
    });
    expect(leads.map((l) => l.customerName)).toEqual(["Ravi Kumar", "Sita Kumar"]);
    expect(leads[0]!.data).toMatchObject({ urgency: "Flexible" });
  });

  describe("calls and leads APIs", () => {
    it("lists calls and shows the timeline only to people allowed to read transcripts", async () => {
      await phoneCall(app, clinic.e164, ["Kiran"]);
      const list = await owner.client.get("/api/v1/calls?limit=50");
      expect(list.statusCode).toBe(200);
      const call = list.json().items[0];
      expect(call.agent.id).toBe(clinic.agentId);
      expect((await owner.client.get(`/api/v1/calls/${call.id}`)).json().collectedData).toBeTypeOf("object");
      expect((await owner.client.get(`/api/v1/calls/${call.id}/events`)).statusCode).toBe(200);

      // STAFF can see calls but not transcripts
      const roles = (await owner.client.get("/api/v1/roles")).json().items;
      const invite = await owner.client.post("/api/v1/invitations", {
        email: uniqueEmail("staff"),
        roleId: roles.find((r: { key: string }) => r.key === "STAFF").id,
      });
      const staff = new Client(app);
      await staff.post("/api/v1/invitations/accept", {
        token: invite.json().inviteUrl.split("/invite/")[1],
        name: "Staff",
        password: STRONG_PASSWORD,
      });
      expect((await staff.get(`/api/v1/calls/${call.id}`)).statusCode).toBe(200);
      expect((await staff.get(`/api/v1/calls/${call.id}/events`)).statusCode).toBe(403);
    });

    it("updates leads with qualification answers validated against the agent's fields", async () => {
      await phoneCall(app, clinic.e164, ["Neha", "whitening", "flexible", "tomorrow", "4 pm", "yes"]);
      const leads = (await owner.client.get("/api/v1/leads?q=Neha")).json().items;
      const lead = leads[0];
      expect(lead.data.service_required).toBe("Teeth whitening");

      const bad = await owner.client.patch(`/api/v1/leads/${lead.id}`, {
        data: { preferred_time: "purple", nonsense: 1 },
      });
      expect(bad.statusCode).toBe(400);
      expect(
        bad
          .json()
          .errors.map((e: { path: string }) => e.path)
          .sort(),
      ).toEqual(["data.nonsense", "data.preferred_time"]);

      const statuses = (await owner.client.get("/api/v1/lead-statuses")).json().items;
      const qualified = statuses.find((s: { key: string }) => s.key === "qualified");
      const ok = await owner.client.patch(`/api/v1/leads/${lead.id}`, {
        statusId: qualified.id,
        data: { preferred_time: "6 pm" },
        notes: "Prefers evenings",
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({
        status: { key: "qualified" },
        notes: "Prefers evenings",
        data: { preferred_time: "18:00" },
      });
    });

    it("manages phone numbers within the tenant only", async () => {
      expect((await owner.client.post("/api/v1/phone-numbers", { e164: "12345" })).statusCode).toBe(400);
      const e164 = `+9170${Math.floor(1e7 + Math.random() * 8e7)}`;
      const created = await owner.client.post("/api/v1/phone-numbers", {
        e164,
        agentId: clinic.agentId,
        friendlyName: "Front desk",
      });
      expect(created.statusCode).toBe(201);
      expect((await owner.client.post("/api/v1/phone-numbers", { e164 })).statusCode).toBe(409);

      const other = await registerOwner(app, "tel-other");
      const theirs = await provisionAgent(app, other.me.tenant.id, "restaurant-booking");
      expect(
        (await owner.client.patch(`/api/v1/phone-numbers/${created.json().id}`, { agentId: theirs.agentId }))
          .statusCode,
      ).toBe(400);
      expect(
        (await other.client.patch(`/api/v1/phone-numbers/${created.json().id}`, { isActive: false }))
          .statusCode,
      ).toBe(404);
      expect(
        (await other.client.get("/api/v1/phone-numbers")).json().items.map((n: { e164: string }) => n.e164),
      ).not.toContain(e164);
    });
  });
});
