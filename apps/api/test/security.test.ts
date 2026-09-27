import { type NestFastifyApplication } from "@nestjs/platform-fastify";
import { totpCode } from "@platform/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, createTestApp, hasTestDb, registerOwner, STRONG_PASSWORD } from "./support/app";

describe.skipIf(!hasTestDb)("P12: two-step sign-in and signed-in devices", () => {
  let app: NestFastifyApplication;
  let owner: Awaited<ReturnType<typeof registerOwner>>;
  let secret = "";
  let recovery: string[] = [];
  /** A code for a different 30-second step, so replay protection doesn't refuse it */
  const code = (offsetSteps = 0) => totpCode(secret, new Date(Date.now() + offsetSteps * 30_000));
  const signIn = async () => {
    const c = new Client(app);
    const res = await c.post("/api/v1/auth/login", { email: owner.email, password: STRONG_PASSWORD });
    return { c, res };
  };

  beforeAll(async () => {
    app = await createTestApp();
    owner = await registerOwner(app, "sec");
  });
  afterAll(() => app.close());

  it("turns on only after a code from the authenticator app is confirmed", async () => {
    const setup = (await owner.client.post("/api/v1/auth/2fa/setup")).json();
    secret = setup.secret;
    expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Voice%20Agent%20Platform%3Asec-/);
    expect((await owner.client.post("/api/v1/auth/2fa/enable", { code: "000000" })).statusCode).toBe(401);
    const on = await owner.client.post("/api/v1/auth/2fa/enable", { code: code() });
    expect(on.statusCode, on.body).toBe(200);
    recovery = on.json().recoveryCodes;
    expect(recovery).toHaveLength(10);
    expect((await owner.client.get("/api/v1/auth/me")).json().user.totpEnabled).toBe(true);
  });

  it("the password alone opens nothing; the code finishes the sign-in, once", async () => {
    const { c, res } = await signIn();
    expect(res.json()).toEqual({ mfaRequired: true, mfaToken: expect.any(String) });
    expect(c.cookie("access_token")).toBeUndefined();
    expect((await c.get("/api/v1/auth/me")).statusCode).toBe(401);
    const first = code(-1);
    const ok = await c.post("/api/v1/auth/login/2fa", { mfaToken: res.json().mfaToken, code: first });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await c.get("/api/v1/auth/me")).statusCode).toBe(200);
    // The same code can't be used again, even within its window
    const again = await signIn();
    expect((await again.c.post("/api/v1/auth/login/2fa", { mfaToken: again.res.json().mfaToken, code: first })).statusCode).toBe(401);
  });

  it("a recovery code works once; five wrong codes end the attempt", async () => {
    const a = await signIn();
    expect((await a.c.post("/api/v1/auth/login/2fa", { mfaToken: a.res.json().mfaToken, code: recovery[0]!.toLowerCase() })).statusCode).toBe(200);
    const b = await signIn();
    expect((await b.c.post("/api/v1/auth/login/2fa", { mfaToken: b.res.json().mfaToken, code: recovery[0]! })).statusCode).toBe(401);
    const c = await signIn();
    const token = c.res.json().mfaToken;
    for (let i = 0; i < 5; i++) await c.c.post("/api/v1/auth/login/2fa", { mfaToken: token, code: "123456" });
    const locked = await c.c.post("/api/v1/auth/login/2fa", { mfaToken: token, code: code(1) });
    expect(locked.json().detail).toContain("Too many wrong codes");
  });

  it("lists signed-in devices and signs one out at once, access included", async () => {
    const phone = await signIn();
    await phone.c.post("/api/v1/auth/login/2fa", { mfaToken: phone.res.json().mfaToken, code: recovery[1]! });
    expect((await phone.c.get("/api/v1/leads")).statusCode).toBe(200);
    const list = (await owner.client.get("/api/v1/auth/sessions")).json().items as { id: string; current: boolean }[];
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(list.length).toBeGreaterThanOrEqual(3);
    const phoneSession = (await phone.c.get("/api/v1/auth/sessions")).json().items.find((s: { current: boolean }) => s.current);
    expect((await owner.client.request("DELETE", `/api/v1/auth/sessions/${phoneSession.id}`)).statusCode).toBe(204);
    // Its access token stops working immediately, and it can't refresh
    expect((await phone.c.get("/api/v1/leads")).statusCode).toBe(401);
    expect((await phone.c.post("/api/v1/auth/refresh")).statusCode).toBe(401);
    // Someone else's session can't be touched
    const other = await registerOwner(app, "sec-other");
    expect((await other.client.request("DELETE", `/api/v1/auth/sessions/${list.find((s) => s.current)!.id}`)).statusCode).toBe(404);
    const out = (await owner.client.post("/api/v1/auth/sessions/revoke-others")).json();
    expect(out.revoked).toBeGreaterThanOrEqual(1);
    expect((await owner.client.get("/api/v1/auth/sessions")).json().items).toHaveLength(1);
    expect((await owner.client.get("/api/v1/leads")).statusCode).toBe(200);
  });

  it("turning it off needs the password and a code", async () => {
    expect((await owner.client.post("/api/v1/auth/2fa/disable", { password: "wrong-password", code: code(1) })).statusCode).toBe(401);
    expect((await owner.client.post("/api/v1/auth/2fa/disable", { password: STRONG_PASSWORD, code: recovery[2]! })).statusCode).toBe(204);
    const { res } = await signIn();
    expect(res.json().user.totpEnabled).toBe(false);
  });
});
