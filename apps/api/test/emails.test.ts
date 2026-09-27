import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invitationEmail } from "../src/modules/mail/templates";
import {
  Client,
  createTestApp,
  hasTestDb,
  registerOwner,
  roleId,
  STRONG_PASSWORD,
  uniqueEmail,
} from "./support/app";

/** A mail server that keeps what it receives */
const mails: { to: string[]; raw: string }[] = [];
const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ["STARTTLS"],
  onData(stream, session, cb) {
    let raw = "";
    stream.on("data", (c: Buffer) => (raw += c.toString()));
    stream.on("end", () => {
      mails.push({ to: session.envelope.rcptTo.map((r) => r.address), raw });
      cb();
    });
  },
});

/** Quoted-printable soft breaks and =XX escapes, enough to read links back */
const decode = (raw: string) =>
  raw
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

async function mailTo(to: string, after = 0, timeoutMs = 5000): Promise<string> {
  const started = Date.now();
  for (;;) {
    const found = mails.slice(after).find((m) => m.to.includes(to));
    if (found) return decode(found.raw);
    if (Date.now() - started > timeoutMs) throw new Error(`no email to ${to}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("templates", () => {
  it("escapes what users typed in the HTML part", () => {
    const m = invitationEmail({
      businessName: 'Bad <script>alert("x")</script>',
      inviterName: "A & B",
      roleName: "Manager",
      url: "https://app.test/invite/abc",
      expiresDays: 7,
    });
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.html).toContain("A &amp; B");
    expect(m.text).toContain("https://app.test/invite/abc");
  });
});

describe.skipIf(!hasTestDb)("platform emails: invitations and password reset", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
    const port = (smtp.server.address() as AddressInfo).port;
    app = await createTestApp({
      SMTP_URL: `smtp://127.0.0.1:${port}`,
      MAIL_FROM: "Voice Agent Platform <no-reply@voice.test>",
    });
  });
  afterAll(async () => {
    await app?.close();
    await new Promise<void>((r) => smtp.close(() => r()));
  });

  it("emails an invitation; resending sends a new link and the old one stops working", async () => {
    const owner = await registerOwner(app, "mailinv");
    const email = uniqueEmail("invitee");
    const before = mails.length;
    const res = await owner.client.post("/api/v1/invitations", {
      email,
      roleId: await roleId(owner, "MANAGER"),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email, emailed: true });

    const first = await mailTo(email, before);
    expect(first).toMatch(/Subject: .*invited you to mailinv Business/);
    expect(first).toContain("From: Voice Agent Platform <no-reply@voice.test>");
    const firstToken = /\/invite\/([A-Za-z0-9_-]+)/.exec(first)![1]!;
    expect(res.json().inviteUrl).toContain(firstToken);

    const again = mails.length;
    const resent = await owner.client.post(`/api/v1/invitations/${res.json().id}/resend`);
    expect(resent.statusCode).toBe(200);
    const second = await mailTo(email, again);
    const secondToken = /\/invite\/([A-Za-z0-9_-]+)/.exec(second)![1]!;
    expect(secondToken).not.toBe(firstToken);

    const accept = (token: string) =>
      new Client(app).post("/api/v1/invitations/accept", {
        token,
        name: "Invitee",
        password: STRONG_PASSWORD,
      });
    expect((await accept(firstToken)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await accept(secondToken)).statusCode).toBe(200);
  });

  it("forgot password: the same answer for unknown emails, and no email", async () => {
    const before = mails.length;
    const res = await new Client(app).post("/api/v1/auth/password/forgot", { email: uniqueEmail("nobody") });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(mails.length).toBe(before);
  });

  it("resets a password with the emailed link, once, and signs out every session", async () => {
    const owner = await registerOwner(app, "mailreset");
    // A second session on another device
    const laptop = new Client(app);
    expect(
      (await laptop.post("/api/v1/auth/login", { email: owner.email, password: STRONG_PASSWORD })).statusCode,
    ).toBe(200);

    const ask = async () => {
      const at = mails.length;
      const r = await new Client(app).post("/api/v1/auth/password/forgot", {
        email: owner.email.toUpperCase(),
      });
      expect(r.statusCode).toBe(202);
      const mail = await mailTo(owner.email, at);
      expect(mail).toMatch(/Subject: Reset your Voice Agent Platform password/);
      return /\/reset-password#([A-Za-z0-9_-]+)/.exec(mail)![1]!;
    };
    const older = await ask();
    const token = await ask();

    const reset = (t: string, password: string) =>
      new Client(app).post("/api/v1/auth/password/reset", { token: t, password });
    // A newer link replaces the older one
    expect((await reset(older, "N3w-Passw0rd!!")).json()).toMatchObject({ code: "TOKEN_EXPIRED" });
    // The password policy applies
    expect((await reset(token, "short")).statusCode).toBe(400);

    expect((await reset(token, "N3w-Passw0rd!!")).statusCode).toBe(204);
    // Used once
    expect((await reset(token, "An0ther-Passw0rd!")).json()).toMatchObject({ code: "TOKEN_EXPIRED" });

    // Both earlier sessions are signed out
    expect((await owner.client.get("/api/v1/auth/me")).statusCode).toBe(401);
    expect((await laptop.get("/api/v1/auth/me")).statusCode).toBe(401);
    // Old password refused, new one works
    const login = (password: string) =>
      new Client(app).post("/api/v1/auth/login", { email: owner.email, password });
    expect((await login(STRONG_PASSWORD)).statusCode).toBe(401);
    expect((await login("N3w-Passw0rd!!")).statusCode).toBe(200);

    // Recorded in the business's audit log
    const client = new Client(app);
    await client.post("/api/v1/auth/login", { email: owner.email, password: "N3w-Passw0rd!!" });
    const audit = await client.get("/api/v1/audit-logs");
    expect(audit.json().items.map((e: { action: string }) => e.action)).toContain("user.password_reset");
  });
});

describe.skipIf(!hasTestDb)("without a platform mail server", () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app?.close());

  it("still returns the invitation link to copy, and says it wasn't emailed", async () => {
    const owner = await registerOwner(app, "nomail");
    const res = await owner.client.post("/api/v1/invitations", {
      email: uniqueEmail("invitee"),
      roleId: await roleId(owner, "MANAGER"),
    });
    expect(res.json()).toMatchObject({ emailed: false });
    expect(res.json().inviteUrl).toMatch(/\/invite\//);
  });
});
