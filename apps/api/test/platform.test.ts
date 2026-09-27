import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { QueueJob } from "@platform/shared";
import type { Job } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../src/infra/prisma.service";
import { JobProcessors } from "../src/modules/jobs/job-processors.service";
import { Client, createTestApp, hasTestDb, registerOwner, STRONG_PASSWORD } from "./support/app";
import { phoneCall, provisionAgent } from "./support/telephony";

describe.skipIf(!hasTestDb)("platform console: businesses, limits, suspending", () => {
  let app: NestFastifyApplication;
  let operator: Awaited<ReturnType<typeof registerOwner>>;
  let customer: Awaited<ReturnType<typeof registerOwner>>;

  beforeAll(async () => {
    app = await createTestApp();
    operator = await registerOwner(app, "platform-op");
    customer = await registerOwner(app, "platform-customer");
  });
  afterAll(() => app.close());

  it("is for platform owners only", async () => {
    expect((await customer.client.get("/api/v1/platform/tenants")).statusCode).toBe(403);
    expect((await operator.client.get("/api/v1/platform/tenants")).statusCode).toBe(403);
    await app.get(PrismaService).client.user.update({
      where: { id: operator.me.user.id },
      data: { isPlatformOwner: true },
    });
    expect((await operator.client.get("/api/v1/platform/tenants")).statusCode).toBe(200);
    // API keys never reach it, even with every scope
    const key = (
      await operator.client.post("/api/v1/api-keys", { name: "all", scopes: ["tenant:read"] })
    ).json().key;
    const machine = new Client(app);
    expect(
      (await machine.get("/api/v1/platform/tenants", { headers: { authorization: `ApiKey ${key}` } }))
        .statusCode,
    ).toBe(403);
  });

  it("lists every business with its activity, and finds them", async () => {
    // By the owner's email: unique, while names repeat across runs of the test database
    const res = (
      await operator.client.get(`/api/v1/platform/tenants?q=${encodeURIComponent(customer.email)}`)
    ).json();
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      id: customer.me.tenant.id,
      name: "platform-customer Business",
      status: "ACTIVE",
      ownerEmail: customer.email,
      members: 1,
      limits: { maxCallsPerDay: 200 },
    });
    expect(res.totals.businesses).toBeGreaterThanOrEqual(2);
  });

  it("changes a business's plan and limits (recorded in its audit log)", async () => {
    const id = customer.me.tenant.id;
    const bad = await operator.client.patch(`/api/v1/platform/tenants/${id}`, {
      limits: { maxCallsPerDay: -1 },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await operator.client.patch(`/api/v1/platform/tenants/${id}`, {
      plan: "growth",
      limits: { maxCallsPerDay: 1000 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ plan: "growth", limits: { maxCallsPerDay: 1000, maxAgents: 3 } });
    expect(ok.json().history[0]).toMatchObject({ action: "platform.plan_changed", by: "platform-op owner" });
  });

  it("suspends a business: no sign-in, no API keys, no calls, no queued work; then reactivates it", async () => {
    const id = customer.me.tenant.id;
    const agent = await provisionAgent(app, id, "clinic-reception", { workingHours: undefined } as never);
    const key = (
      await customer.client.post("/api/v1/api-keys", { name: "crm", scopes: ["tenant:read"] })
    ).json().key;
    const machine = new Client(app);
    const byKey = () => machine.get("/api/v1/tenant", { headers: { authorization: `ApiKey ${key}` } });
    expect((await byKey()).statusCode).toBe(200);

    expect(
      (await operator.client.post(`/api/v1/platform/tenants/${id}/status`, { status: "SUSPENDED" }))
        .statusCode,
    ).toBe(400);
    // Not the business you're signed in to (you'd lock yourself out)
    expect(
      (
        await operator.client.post(`/api/v1/platform/tenants/${operator.me.tenant.id}/status`, {
          status: "SUSPENDED",
          reason: "test",
        })
      ).statusCode,
    ).toBe(409);
    const suspended = await operator.client.post(`/api/v1/platform/tenants/${id}/status`, {
      status: "SUSPENDED",
      reason: "Unpaid invoice",
    });
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json()).toMatchObject({ status: "SUSPENDED", statusReason: "Unpaid invoice" });

    const session = await customer.client.get("/api/v1/tenant");
    expect(session.statusCode).toBe(403);
    expect(session.json().code).toBe("TENANT_SUSPENDED");
    const login = await new Client(app).post("/api/v1/auth/login", {
      email: customer.email,
      password: STRONG_PASSWORD,
    });
    expect(login.statusCode).toBe(403);
    expect(login.json()).toMatchObject({
      code: "TENANT_SUSPENDED",
      detail: expect.stringMatching(/suspended/),
    });
    expect((await byKey()).statusCode).toBe(401);
    const call = await phoneCall(app, agent.e164, []);
    expect(call.last.say).toContain("not in service");
    const job = {
      data: { kind: "email", tenantId: id },
      attemptsMade: 0,
      opts: {},
    } as unknown as Job<QueueJob>;
    await expect(app.get(JobProcessors).process(job)).resolves.toEqual({ skipped: "business suspended" });

    const back = await operator.client.post(`/api/v1/platform/tenants/${id}/status`, {
      status: "ACTIVE",
      reason: "Paid",
    });
    expect(back.json()).toMatchObject({ status: "ACTIVE" });
    expect(
      back
        .json()
        .history.map((h: { action: string }) => h.action)
        .slice(0, 2),
    ).toEqual(["platform.tenant_reactivated", "platform.tenant_suspended"]);
    expect((await customer.client.get("/api/v1/tenant")).statusCode).toBe(200);
    expect((await byKey()).statusCode).toBe(200);
  });
});
