import { type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/bootstrap";
import { loadApiEnv } from "../src/config/env";

// Points at ports where nothing listens, so /ready must report failure
const env = loadApiEnv({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none?connect_timeout=1",
  REDIS_URL: "redis://127.0.0.1:1",
  LOG_LEVEL: "silent",
  // No queue workers: they would keep retrying the unreachable Redis after the tests
  QUEUE_CONSUMERS: "false",
  JWT_SECRET: "test-only-jwt-secret-0123456789abcdefghij",
  MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
});

describe("health endpoints", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApp(env, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it("GET /health is always ok and returns a request id", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("GET /ready returns problem+json 503 when dependencies are down", async () => {
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.json()).toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });
    expect(res.json().detail).toContain("database");
  });

  it("only trusts X-Forwarded-For from configured proxies", async () => {
    const trusted = await createApp({ ...env, TRUST_PROXY: ["10.0.0.1"] }, { logger: false });
    trusted
      .getHttpAdapter()
      .getInstance()
      .get("/whoami", async (req) => ({ ip: req.ip }));
    await trusted.init();
    await trusted.getHttpAdapter().getInstance().ready();
    const viaProxy = await trusted.inject({
      method: "GET",
      url: "/whoami",
      remoteAddress: "10.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    const spoofed = await trusted.inject({
      method: "GET",
      url: "/whoami",
      remoteAddress: "198.51.100.7",
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    await trusted.close();
    expect(viaProxy.json().ip).toBe("203.0.113.9");
    expect(spoofed.json().ip).toBe("198.51.100.7");
  });

  it("unknown routes return problem+json 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
  });
});
