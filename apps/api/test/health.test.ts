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

  it("unknown routes return problem+json 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
  });
});
