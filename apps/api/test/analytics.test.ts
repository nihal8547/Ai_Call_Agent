import { type NestFastifyApplication } from "@nestjs/platform-fastify";
import { rollupAnalytics } from "@platform/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../src/infra/prisma.service";
import { QueueService } from "../src/infra/queue.service";
import { TenantDbService } from "../src/infra/tenant-db.service";
import { csvCell } from "../src/modules/analytics/analytics.service";
import { addMember, createTestApp, hasTestDb, registerOwner } from "./support/app";
import { phoneCall, provisionAgent, twilioPost } from "./support/telephony";

const todayIST = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const hourIST = () =>
  Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hourCycle: "h23" }).format(
      new Date(),
    ),
  );

describe("CSV cells", () => {
  it("quotes separators and neutralises formulas", () => {
    expect(csvCell("Front desk, main")).toBe('"Front desk, main"');
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell(-5)).toBe("-5");
  });
});

describe.skipIf(!hasTestDb)("P11: analytics roll-ups, report and export", () => {
  let app: NestFastifyApplication;
  let owner: Awaited<ReturnType<typeof registerOwner>>;
  let clinic: Awaited<ReturnType<typeof provisionAgent>>;
  let other: Awaited<ReturnType<typeof provisionAgent>>;
  const tenantId = () => owner.me.tenant.id;
  const end = async (call: Awaited<ReturnType<typeof phoneCall>>, seconds: number) =>
    twilioPost(app, "/telephony/twilio/status", {
      ...call.base,
      CallStatus: "completed",
      CallDuration: String(seconds),
    });
  const rollup = () =>
    rollupAnalytics(
      app.get(PrismaService).client,
      tenantId(),
      new Date(Date.now() - 3_600_000 * 3),
      new Date(Date.now() + 1000),
    );

  beforeAll(async () => {
    app = await createTestApp();
    owner = await registerOwner(app, "analytics");
    clinic = await provisionAgent(app, tenantId(), "clinic-reception", { workingHours: undefined });
    other = await provisionAgent(app, tenantId(), "clinic-reception", { workingHours: undefined });
    const agentName = '=cmd|" /C calc"!A0';
    await app
      .get(TenantDbService)
      .db(tenantId())
      .agent.update({ where: { id: other.agentId }, data: { name: agentName } });

    // A booking, an emergency nobody picked up, a question the agent couldn't answer, a hang-up
    await end(
      await phoneCall(app, clinic.e164, ["Priya", "cleaning", "flexible", "tomorrow", "10 am", "yes"]),
      95,
    );
    const emergency = await phoneCall(app, clinic.e164, ["Kiran", "root canal", "it's an emergency"]);
    await twilioPost(app, "/telephony/twilio/dial-status", {
      ...emergency.base,
      DialCallStatus: "no-answer",
    });
    await end(emergency, 60);
    await end(await phoneCall(app, clinic.e164, ["Do you have free parking?", "Arjun"]), 40);
    await end(await phoneCall(app, other.e164, ["Meera"]), 20);
  });
  afterAll(() => app.close());

  it("queues a roll-up when a call ends (the worker runs it)", async () => {
    const jobs = await app.get(QueueService).queue("analytics").getJobs(["delayed", "waiting"]);
    expect(jobs.map((j) => j.data)).toContainEqual(
      expect.objectContaining({ kind: "rollup", tenantId: tenantId() }),
    );
  });

  it("reports calls, outcomes, the funnel, latency, tools and knowledge from the roll-ups", async () => {
    await rollup();
    const today = todayIST();
    const res = await owner.client.get(`/api/v1/analytics/report?from=${today}&to=${today}`);
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(r.totals).toMatchObject({
      calls: 4,
      answered: 4,
      completed: 4,
      booked: 1,
      // The missed transfer, and the question nobody could answer yet
      followUp: 2,
      transfersMissed: 1,
      questions: 1,
      questionsAnswered: 0,
      avgDurationSec: Math.round((95 + 60 + 40 + 20) / 4),
    });
    expect(r.totals.costMicros).toBeGreaterThan(0);
    expect(r.cost).toMatchObject({ currency: "USD", estimated: true, totalMicros: r.totals.costMicros });
    expect(r.series).toEqual([expect.objectContaining({ day: today, calls: 4, booked: 1 })]);
    expect(r.byHour[hourIST()]).toBe(4);
    expect(r.outcomes).toMatchObject({ APPOINTMENT_BOOKED: 1, FOLLOW_UP_REQUIRED: 2 });
    // Everyone gave a name, two a service, and only the booking got as far as a date
    expect(r.funnel.slice(0, 2)).toEqual([
      { key: "patient_name", label: "Patient name", count: 4 },
      { key: "service_required", label: "Service", count: 2 },
    ]);
    expect(r.funnel.find((f: { key: string }) => f.key === "preferred_date").count).toBe(1);
    const turn = r.latency.find((l: { hop: string }) => l.hop === "turn");
    expect(turn.count).toBeGreaterThan(5);
    expect(turn.p50).toBeGreaterThanOrEqual(0);
    expect(turn.p95).toBeGreaterThanOrEqual(turn.p50);
    expect(r.tools).toContainEqual({
      tool: "appointments.create",
      label: "Book appointment",
      runs: 1,
      failed: 0,
    });
    expect(r.knowledge).toMatchObject({
      questions: 1,
      answered: 0,
      unanswered: [{ reason: expect.any(String), count: 1 }],
    });
    expect(r.updatedAt).not.toBeNull();

    // One agent at a time
    const one = (
      await owner.client.get(`/api/v1/analytics/report?from=${today}&to=${today}&agentId=${other.agentId}`)
    ).json();
    expect(one.totals.calls).toBe(1);
  });

  it("rebuilding gives the same numbers", async () => {
    const today = todayIST();
    const before = (await owner.client.get(`/api/v1/analytics/report?from=${today}&to=${today}`)).json();
    await rollup();
    await rollup();
    const after = (await owner.client.get(`/api/v1/analytics/report?from=${today}&to=${today}`)).json();
    expect(after.totals).toEqual(before.totals);
    expect(await app.get(TenantDbService).db(tenantId()).analyticsHourly.count()).toBe(2);
  });

  it("hides cost from people without billing access, in the report and the export", async () => {
    const today = todayIST();
    const manager = await addMember(app, owner, "MANAGER");
    const r = (await manager.client.get(`/api/v1/analytics/report?from=${today}&to=${today}`)).json();
    expect(r.cost).toBeNull();
    expect(r.totals.costMicros).toBeUndefined();
    expect(r.series[0].costMicros).toBeUndefined();
    const csv = await manager.client.get(`/api/v1/analytics/export.csv?from=${today}&to=${today}`);
    expect(csv.body).not.toContain("cost");
    const staff = await addMember(app, owner, "STAFF");
    expect((await staff.client.get(`/api/v1/analytics/report?from=${today}&to=${today}`)).statusCode).toBe(
      403,
    );
  });

  it("exports one row per day and agent, safe to open in a spreadsheet", async () => {
    const today = todayIST();
    const res = await owner.client.get(`/api/v1/analytics/export.csv?from=${today}&to=${today}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="analytics-${today}-to-${today}.csv"`,
    );
    const lines = res.body.trim().split("\r\n");
    expect(lines[0]).toMatch(/^Date,Agent,Calls,Answered,.*,Estimated cost \(USD\)$/);
    expect(lines).toHaveLength(3);
    expect(
      lines.find((l: string) => l.includes(clinic.config.agentName) || l.includes("clinic-reception")),
    ).toMatch(new RegExp(`^${today},[^,]+,3,3,3,0,`));
    // The hostile agent name can't run as a formula
    expect(res.body).toContain(`"'=cmd|"" /C calc""!A0"`);
  });

  it("rejects ranges that make no sense", async () => {
    expect(
      (await owner.client.get("/api/v1/analytics/report?from=2026-10-02&to=2026-10-01")).statusCode,
    ).toBe(400);
    expect(
      (await owner.client.get("/api/v1/analytics/report?from=2024-01-01&to=2026-10-01")).statusCode,
    ).toBe(400);
  });
});
