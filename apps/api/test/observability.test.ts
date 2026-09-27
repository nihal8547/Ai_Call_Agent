import { type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, hasTestDb, registerOwner } from "./support/app";
import { phoneCall, provisionAgent } from "./support/telephony";

describe.skipIf(!hasTestDb)("P12: Prometheus metrics", () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  it("answers private-network scrapers only, and counts calls, turns and requests by route", async () => {
    const owner = await registerOwner(app, "metrics");
    const clinic = await provisionAgent(app, owner.me.tenant.id, "clinic-reception", {
      workingHours: undefined,
    });
    await phoneCall(app, clinic.e164, ["Priya"]);
    await owner.client.get(`/api/v1/agents/${clinic.agentId}`);

    expect((await app.inject({ url: "/metrics", remoteAddress: "203.0.113.9" })).statusCode).toBe(404);
    const res = await app.inject({ url: "/metrics", remoteAddress: "10.1.2.3" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toMatch(/voice_calls_total\{connection="TWILIO",result="answered"\} [1-9]/);
    expect(res.body).toMatch(/voice_turns_total\{ai="false"\} [2-9]/);
    expect(res.body).toContain('voice_turn_duration_seconds_bucket{le="1.2",ai="false"}');
    expect(res.body).toContain('queue_jobs{queue="webhooks",state="waiting"}');
    // Route patterns, never raw ids
    expect(res.body).toContain('route="/api/v1/agents/:id"');
    expect(res.body).not.toContain(clinic.agentId);
  });

  it("needs the bearer token when one is configured", async () => {
    const secured = await createTestApp({ METRICS_TOKEN: "scrape-token-0123456789" });
    try {
      expect((await secured.inject({ url: "/metrics", remoteAddress: "10.1.2.3" })).statusCode).toBe(404);
      const ok = await secured.inject({
        url: "/metrics",
        remoteAddress: "203.0.113.9",
        headers: { authorization: "Bearer scrape-token-0123456789" },
      });
      expect(ok.statusCode).toBe(200);
    } finally {
      await secured.close();
    }
  });
});
