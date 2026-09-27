import { type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantDbService } from "../src/infra/tenant-db.service";
import { Client, createTestApp, hasTestDb, registerOwner, STRONG_PASSWORD, uniqueEmail } from "./support/app";

describe.skipIf(!hasTestDb)("agent editor: versions, restore, publish checks and test console", () => {
  let app: NestFastifyApplication;
  let owner: Awaited<ReturnType<typeof registerOwner>>;

  beforeAll(async () => {
    app = await createTestApp();
    owner = await registerOwner(app, "editor");
  });
  afterAll(() => app.close());

  const newAgent = async (templateKey: string) => {
    const res = await owner.client.post("/api/v1/agents", {
      name: `A ${Math.random().toString(36).slice(2, 8)}`,
      templateKey,
    });
    return res.json().id as string;
  };
  const draftOf = async (id: string) => (await owner.client.get(`/api/v1/agents/${id}`)).json().draft.config;
  const saveDraft = (id: string, config: unknown, changeNote?: string) =>
    owner.client.request("PUT", `/api/v1/agents/${id}/draft`, {
      config,
      ...(changeNote ? { changeNote } : {}),
    });

  it("new agents say they're an AI assistant after the greeting; the business can turn it off", async () => {
    const id = await newAgent("clinic-reception");
    const config = await draftOf(id);
    expect(config.disclosure).toEqual({ ai: true, message: "" });
    const start = await owner.client.post(`/api/v1/agents/${id}/test-sessions`, {});
    expect(start.json().reply).toContain("Just so you know, I'm an AI assistant.");

    expect((await saveDraft(id, { ...config, disclosure: { ai: false, message: "" } })).statusCode).toBe(200);
    const quiet = await owner.client.post(`/api/v1/agents/${id}/test-sessions`, {});
    expect(quiet.json().reply).not.toContain("AI assistant");
  });

  it("keeps a version history and restores an earlier version into the draft", async () => {
    const id = await newAgent("restaurant-booking");
    await owner.client.post(`/api/v1/agents/${id}/publish`); // v1
    const v2 = (await owner.client.get(`/api/v1/agents/${id}`)).json().published.config;
    v2.greeting = "Welcome to {{business_name}}! I'm {{agent_name}}.";
    await saveDraft(id, v2, "Shorter greeting");
    await owner.client.post(`/api/v1/agents/${id}/publish`); // v2

    const history = (await owner.client.get(`/api/v1/agents/${id}/versions`)).json().items;
    expect(history.map((v: { version: number; status: string }) => [v.version, v.status])).toEqual([
      [2, "PUBLISHED"],
      [1, "RETIRED"],
    ]);
    expect(history[0].changeNote).toBe("Shorter greeting");

    const v1 = history[1];
    const restored = await owner.client.post(`/api/v1/agents/${id}/versions/${v1.id}/restore`);
    expect(restored.json()).toMatchObject({
      version: 3,
      status: "DRAFT",
      changeNote: "Restored from version 1",
    });
    expect(restored.json().config.greeting).toBe(
      (await owner.client.get(`/api/v1/agents/${id}/versions/${v1.id}`)).json().config.greeting,
    );
  });

  it("refuses to publish tools that cannot run yet, but lets drafts reference them", async () => {
    const id = await newAgent("clinic-reception");
    const config = await draftOf(id);
    config.tools = [...config.tools, "calendar.book", "sms.send"];
    expect((await saveDraft(id, config)).statusCode).toBe(200);
    const res = await owner.client.post(`/api/v1/agents/${id}/publish`);
    expect(res.statusCode).toBe(400);
    expect(res.json().errors).toEqual([
      {
        path: "config.tools.2",
        message: 'Connect Google Calendar and choose it for "Book in Google Calendar"',
      },
      { path: "config.tools.3", message: '"Send SMS" is not available yet' },
    ]);
  });

  describe("test console", () => {
    it("runs the draft end to end with simulated tools and writes nothing", async () => {
      const id = await newAgent("clinic-reception");
      const db = app.get(TenantDbService).db(owner.me.tenant.id);
      const before = await Promise.all([db.call.count(), db.lead.count(), db.appointment.count()]);

      // Monday 11:30 in India: the clinic is open
      const start = await owner.client.post(`/api/v1/agents/${id}/test-sessions`, {
        simulatedAt: "2026-09-28T06:00:00Z",
      });
      expect(start.statusCode).toBe(201);
      const { sessionId } = start.json();
      expect(start.json().reply).toContain("May I have the patient's name?");

      let last: Record<string, unknown> & { state: Record<string, unknown> } = start.json();
      for (const text of ["Priya", "cleaning", "flexible", "tomorrow", "10 am", "yes"]) {
        const r = await owner.client.post(`/api/v1/test-sessions/${sessionId}/messages`, { text });
        expect(r.statusCode).toBe(200);
        last = r.json();
      }
      expect(last.reply).toContain("Your appointment is confirmed for Tuesday, 29 September at 10 AM");
      expect(last.state).toMatchObject({
        ended: true,
        outcome: "APPOINTMENT_BOOKED",
        collected: { patient_name: "Priya" },
      });
      expect((last.toolCalls as { tool: string }[]).map((t) => t.tool)).toEqual([
        "appointments.create",
        "leads.create",
      ]);

      const after = await Promise.all([db.call.count(), db.lead.count(), db.appointment.count()]);
      expect(after).toEqual(before);
      expect(
        (await owner.client.post(`/api/v1/test-sessions/${sessionId}/messages`, { text: "hello?" }))
          .statusCode,
      ).toBe(409);
    });

    it("follows the draft's branches and simulated clock", async () => {
      const id = await newAgent("clinic-reception");
      const night = await owner.client.post(`/api/v1/agents/${id}/test-sessions`, {
        simulatedAt: "2026-09-28T18:30:00Z",
      });
      expect(night.json().reply).toContain("Our office is closed right now");

      const day = (
        await owner.client.post(`/api/v1/agents/${id}/test-sessions`, { simulatedAt: "2026-09-28T06:00:00Z" })
      ).json();
      let r = day;
      for (const text of ["Priya", "root canal", "emergency"])
        r = (await owner.client.post(`/api/v1/test-sessions/${day.sessionId}/messages`, { text })).json();
      expect(r).toMatchObject({ control: "transfer", transferTo: "+911140000099" });
    });

    it("rehearses tool outages", async () => {
      const id = await newAgent("restaurant-booking");
      const s = (await owner.client.post(`/api/v1/agents/${id}/test-sessions`, { failTools: true })).json();
      let r = s;
      for (const text of ["Sam", "2 people", "tomorrow", "8 pm", "none", "yes"])
        r = (await owner.client.post(`/api/v1/test-sessions/${s.sessionId}/messages`, { text })).json();
      expect(r.reply).toContain("I couldn't complete that just now");
    });

    it("sessions are private to the person who started them", async () => {
      const id = await newAgent("hotel-reservations");
      const s = (await owner.client.post(`/api/v1/agents/${id}/test-sessions`, {})).json();
      const roles = (await owner.client.get("/api/v1/roles")).json().items;
      const invite = await owner.client.post("/api/v1/invitations", {
        email: uniqueEmail("adm"),
        roleId: roles.find((x: { key: string }) => x.key === "ADMIN").id,
      });
      const admin = new Client(app);
      await admin.post("/api/v1/invitations/accept", {
        token: invite.json().inviteUrl.split("/invite/")[1],
        name: "Admin",
        password: STRONG_PASSWORD,
        acceptTerms: true,
      });
      expect(
        (await admin.post(`/api/v1/test-sessions/${s.sessionId}/messages`, { text: "hi" })).statusCode,
      ).toBe(404);

      const other = await registerOwner(app, "editor-other");
      expect((await other.client.post(`/api/v1/agents/${id}/test-sessions`, {})).statusCode).toBe(404);
    });
  });
});
