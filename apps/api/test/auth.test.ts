import { type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, createTestApp, hasTestDb, registerOwner, STRONG_PASSWORD, uniqueEmail } from "./support/app";

describe.skipIf(!hasTestDb)("auth", () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  describe("register", () => {
    it("creates the business and signs the owner in", async () => {
      const client = new Client(app);
      const email = uniqueEmail("reg");
      const res = await client.post("/api/v1/auth/register", {
        name: "Asha",
        email: email.toUpperCase(),
        password: STRONG_PASSWORD,
        businessName: "Asha Dental Clinic",
        industry: "healthcare",
      });
      expect(res.statusCode).toBe(201);
      const me = res.json();
      expect(me.user.email).toBe(email);
      expect(me.role.key).toBe("OWNER");
      expect(me.tenant.slug).toMatch(/^asha-dental-clinic/);
      expect(me.permissions).toContain("billing:write");

      const setCookies = res.cookies as { name: string; httpOnly?: boolean; sameSite?: string }[];
      expect(setCookies.find((c) => c.name === "access_token")).toMatchObject({
        httpOnly: true,
        sameSite: "Lax",
      });
      expect(setCookies.find((c) => c.name === "refresh_token")).toMatchObject({ httpOnly: true });
      expect(setCookies.find((c) => c.name === "csrf_token")?.httpOnly).toBeFalsy();

      const again = await client.get("/api/v1/auth/me");
      expect(again.statusCode).toBe(200);
      expect(again.json().tenant.id).toBe(me.tenant.id);
    });

    it("rejects a duplicate email with a field error", async () => {
      const { email } = await registerOwner(app, "dup");
      const res = await new Client(app).post("/api/v1/auth/register", {
        name: "X",
        email,
        password: STRONG_PASSWORD,
        businessName: "Another",
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().errors[0].path).toBe("email");
    });

    it("returns every validation problem at once", async () => {
      const res = await new Client(app).post("/api/v1/auth/register", { email: "nope", password: "weak" });
      expect(res.statusCode).toBe(400);
      expect(res.headers["content-type"]).toContain("application/problem+json");
      const paths = res.json().errors.map((e: { path: string }) => e.path);
      expect(paths).toEqual(expect.arrayContaining(["name", "email", "password", "businessName"]));
    });
  });

  describe("login", () => {
    it("signs in with correct credentials", async () => {
      const { email } = await registerOwner(app, "login");
      const client = new Client(app);
      const res = await client.post("/api/v1/auth/login", { email, password: STRONG_PASSWORD });
      expect(res.statusCode).toBe(200);
      expect((await client.get("/api/v1/auth/me")).statusCode).toBe(200);
    });

    it("gives the same answer for a wrong password and an unknown email", async () => {
      const { email } = await registerOwner(app, "wrongpw");
      const wrong = await new Client(app).post("/api/v1/auth/login", { email, password: "Wrong-Passw0rd!" });
      const unknown = await new Client(app).post("/api/v1/auth/login", {
        email: uniqueEmail("ghost"),
        password: STRONG_PASSWORD,
      });
      expect([wrong.statusCode, unknown.statusCode]).toEqual([401, 401]);
      expect(wrong.json().code).toBe("INVALID_CREDENTIALS");
      expect(unknown.json().detail).toBe(wrong.json().detail);
    });

    it("rate-limits repeated attempts for one email", async () => {
      const email = uniqueEmail("brute");
      const codes: number[] = [];
      for (let i = 0; i < 11; i++) {
        codes.push((await new Client(app).post("/api/v1/auth/login", { email, password: "x" })).statusCode);
      }
      expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
      expect(codes[10]).toBe(429);
    });
  });

  describe("session security", () => {
    it("requires authentication", async () => {
      const res = await new Client(app).get("/api/v1/members");
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("UNAUTHENTICATED");
    });

    it("rejects state-changing requests without the CSRF header", async () => {
      const { client } = await registerOwner(app, "csrf");
      const res = await client.patch("/api/v1/tenant", { name: "Hijacked" }, { csrf: false });
      expect(res.statusCode).toBe(403);
      expect((await client.patch("/api/v1/tenant", { name: "Legit Name" })).statusCode).toBe(200);
    });

    it("rotates refresh tokens and revokes the family when an old token is replayed", async () => {
      const { client } = await registerOwner(app, "rotate");
      const first = client.cookie("refresh_token")!;

      expect((await client.post("/api/v1/auth/refresh")).statusCode).toBe(200);
      const second = client.cookie("refresh_token")!;
      expect(second).not.toBe(first);

      // An attacker replays the first (already used) token
      const attacker = new Client(app);
      attacker.setCookie("refresh_token", first);
      attacker.setCookie("csrf_token", client.cookie("csrf_token")!);
      expect((await attacker.post("/api/v1/auth/refresh")).statusCode).toBe(401);

      // …which also kills the legitimate session's current token
      expect((await client.post("/api/v1/auth/refresh")).statusCode).toBe(401);
    });

    it("logs out", async () => {
      const { client } = await registerOwner(app, "logout");
      expect((await client.post("/api/v1/auth/logout")).statusCode).toBe(204);
      expect((await client.get("/api/v1/auth/me")).statusCode).toBe(401);
      expect((await client.post("/api/v1/auth/refresh")).statusCode).toBe(401);
    });
  });
});
