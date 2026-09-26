import { type NestFastifyApplication } from "@nestjs/platform-fastify";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TenantDbService } from "../src/infra/tenant-db.service";
import { addMember, createTestApp, hasTestDb, registerOwner } from "./support/app";
import { phoneCall, provisionAgent, twilioPost } from "./support/telephony";

type Owner = Awaited<ReturnType<typeof registerOwner>>;

/** A webhook receiver that answers with the next queued status (then 200) */
const received: { body: string; key: string | undefined }[] = [];
const statuses: number[] = [];
const receiver = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ body, key: req.headers["idempotency-key"] as string | undefined });
    res.writeHead(statuses.shift() ?? 200).end();
  });
});

describe.skipIf(!hasTestDb)("P11: background jobs, retries and the failed-jobs list", () => {
  let app: NestFastifyApplication;
  let owner: Owner;
  let e164 = "";
  const db = () => app.get(TenantDbService).db(owner.me.tenant.id);

  beforeAll(async () => {
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
    app = await createTestApp();
    owner = await registerOwner(app, "jobs");
    const hook = (
      await owner.client.post("/api/v1/integrations", {
        type: "WEBHOOK",
        name: "CRM hook",
        config: { url: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/calls` },
      })
    ).json();
    // After the intake questions, the agent posts the caller's details without waiting
    const agent = await provisionAgent(app, owner.me.tenant.id, "clinic-reception", {
      workingHours: undefined,
      tools: ["leads.create", "appointments.create", "webhook.post"],
      workflow: {
        steps: [
          { id: "greet", type: "greeting" },
          { id: "intake", type: "collect_fields", fields: ["patient_name", "service_required"] },
          {
            id: "notify",
            type: "tool",
            tool: "webhook.post",
            background: true,
            input: { event: "intake", name: "{{patient_name}}" },
          },
          { id: "close", type: "end", text: "Thanks {{patient_name}}, we'll call you back." },
        ],
      },
    } as never);
    const bound = await owner.client.request("PUT", `/api/v1/agents/${agent.agentId}/tool-bindings`, {
      bindings: [{ toolName: "webhook.post", integrationId: hook.id }],
    });
    expect(bound.statusCode, bound.body).toBe(200);
    e164 = agent.e164;
  });
  afterAll(async () => {
    receiver.close();
    await app.close();
  });

  const timelineOf = async (callSid: string) => {
    const call = await db().call.findUniqueOrThrow({ where: { providerCallSid: callSid } });
    return db().callEvent.findMany({
      where: { callId: call.id, type: "TOOL_CALL" },
      orderBy: { seq: "asc" },
    });
  };

  it("a background webhook is retried until the receiver recovers, without delaying the caller", async () => {
    received.length = 0;
    statuses.push(503, 503); // down twice, then fine
    const call = await phoneCall(app, e164, ["Priya", "cleaning"]);
    expect(call.last.say).toBe("Thanks Priya, we'll call you back.");

    await vi.waitFor(() => expect(received).toHaveLength(3), { timeout: 5000 });
    // Every attempt carries the same idempotency key, so the receiver can drop repeats
    expect(new Set(received.map((r) => r.key)).size).toBe(1);
    expect(JSON.parse(received[2]!.body)).toMatchObject({ event: "call.tool", data: { name: "Priya" } });
    await vi.waitFor(async () => {
      const events = await timelineOf(call.callSid);
      expect(events.at(-1)!.payload).toMatchObject({
        phase: "executed",
        background: true,
        tool: "webhook.post",
        ok: true,
        attempts: 3,
      });
    });
  });

  it("a delivery the receiver refuses goes to the failed-jobs list, and can be sent again", async () => {
    received.length = 0;
    statuses.push(400); // rejected: not worth retrying
    const call = await phoneCall(app, e164, ["Arjun", "braces"]);
    await vi.waitFor(async () => {
      const list = (await owner.client.get("/api/v1/jobs/failed")).json();
      expect(list.open).toBe(1);
    });
    expect(received).toHaveLength(1);
    const list = (await owner.client.get("/api/v1/jobs/failed")).json();
    const failed = list.items[0];
    expect(failed).toMatchObject({
      queue: "webhooks",
      label: expect.stringContaining("webhook"),
      error: expect.stringContaining("rejected"),
      attempts: 1,
      status: "FAILED",
      callId: expect.any(String),
    });
    expect(failed.payload).toBeUndefined();
    const events = await timelineOf(call.callSid);
    expect(events.at(-1)!.payload).toMatchObject({ background: true, ok: false, error: "rejected" });

    // Only people who manage integrations can resend
    const manager = await addMember(app, owner, "MANAGER");
    expect((await manager.client.get("/api/v1/jobs/failed")).json().open).toBe(1);
    expect((await manager.client.post(`/api/v1/jobs/failed/${failed.id}/retry`)).statusCode).toBe(403);
    const staff = await addMember(app, owner, "STAFF");
    expect((await staff.client.get("/api/v1/jobs/failed")).statusCode).toBe(403);

    // The receiver is fixed; resend
    const retried = await owner.client.post(`/api/v1/jobs/failed/${failed.id}/retry`);
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({ status: "RETRIED", resolvedAt: expect.any(String) });
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[1]!.key).toBe(received[0]!.key);
    expect((await owner.client.post(`/api/v1/jobs/failed/${failed.id}/retry`)).statusCode).toBe(409);
    expect((await owner.client.get("/api/v1/jobs/failed")).json().open).toBe(0);
    const audit = await db().auditLog.findFirst({ where: { action: "job.retried", entityId: failed.id } });
    expect(audit).not.toBeNull();

    // Other businesses never see it
    const outsider = await registerOwner(app, "jobs-outsider");
    expect((await outsider.client.get("/api/v1/jobs/failed")).json().items).toEqual([]);
    expect((await outsider.client.post(`/api/v1/jobs/failed/${failed.id}/dismiss`)).statusCode).toBe(404);
  });

  it("a missed-transfer email with no email integration is listed for staff instead of lost", async () => {
    const clinic = await provisionAgent(app, owner.me.tenant.id, "clinic-reception", {
      workingHours: undefined,
      handoff: {
        enabled: true,
        phoneNumber: "+911140000099",
        message: "Connecting you now.",
        unavailableMessage: "Nobody is free. We'll call you back.",
        notifyEmails: ["owner@clinic.test"],
      },
    });
    const call = await phoneCall(app, clinic.e164, ["Kiran", "root canal", "it's an emergency"]);
    await twilioPost(app, "/telephony/twilio/dial-status", { ...call.base, DialCallStatus: "no-answer" });
    await vi.waitFor(async () => {
      const items = (await owner.client.get("/api/v1/jobs/failed?status=FAILED")).json().items;
      expect(items).toContainEqual(
        expect.objectContaining({
          queue: "notifications",
          label: expect.stringContaining("Missed-transfer email"),
          error: "No email integration is connected",
        }),
      );
    });
    const item = (await owner.client.get("/api/v1/jobs/failed?status=FAILED")).json().items[0];
    const dismissed = await owner.client.post(`/api/v1/jobs/failed/${item.id}/dismiss`);
    expect(dismissed.json()).toMatchObject({ status: "DISMISSED" });
    expect((await owner.client.get("/api/v1/jobs/failed?status=DISMISSED")).json().items).toHaveLength(1);
  });
});

describe.skipIf(!hasTestDb)("P11: queue dashboard for platform operators", () => {
  const PASSWORD = "operator-board-password-123";
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await createTestApp({ ADMIN_BOARD_PASSWORD: PASSWORD });
  });
  afterAll(() => app.close());

  it("is behind its own password, separate from tenant logins", async () => {
    expect((await app.inject({ url: "/admin/queues" })).statusCode).toBe(401);
    const wrong = Buffer.from("admin:not-the-password").toString("base64");
    expect(
      (await app.inject({ url: "/admin/queues", headers: { authorization: `Basic ${wrong}` } })).statusCode,
    ).toBe(401);
    const auth = { authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}` };
    const page = await app.inject({ url: "/admin/queues", headers: auth });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<div id="root"');
    const api = await app.inject({ url: "/admin/queues/api/queues", headers: auth });
    expect(api.statusCode).toBe(200);
    expect(api.json().queues.map((q: { name: string }) => q.name)).toEqual(
      expect.arrayContaining(["webhooks", "notifications", "crm", "analytics", "ingestion"]),
    );
  });

  it("does not exist unless configured", async () => {
    const plain = await createTestApp();
    try {
      expect((await plain.inject({ url: "/admin/queues" })).statusCode).toBe(404);
    } finally {
      await plain.close();
    }
  });
});
