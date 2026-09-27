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

beforeAll(() => new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r)));
afterAll(() => new Promise<void>((r) => smtp.close(() => r())));
const smtpUrl = () => `smtp://127.0.0.1:${(smtp.server.address() as AddressInfo).port}`;

/** Quoted-printable soft breaks and =XX escapes, enough to read links back */
const decode = (raw: string) =>
  raw
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

/** The first email to `to` since `after`, optionally only one whose raw text matches `like` */
async function mailTo(to: string, after = 0, like?: RegExp, timeoutMs = 5000): Promise<string> {
  const started = Date.now();
  for (;;) {
    const found = mails.slice(after).find((m) => m.to.includes(to) && (!like || like.test(decode(m.raw))));
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
    app = await createTestApp({
      SMTP_URL: smtpUrl(),
      MAIL_FROM: "Voice Agent Platform <no-reply@voice.test>",
    });
  });
  afterAll(() => app?.close());

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
        acceptTerms: true,
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
      // Signing up also emailed a confirmation link, maybe still on its way
      const mail = await mailTo(owner.email, at, /reset-password#/);
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

describe.skipIf(!hasTestDb)("confirming the email address after sign-up", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp({ SMTP_URL: smtpUrl() });
  });
  afterAll(() => app?.close());

  const tokenIn = (mail: string) => /\/verify-email#([A-Za-z0-9_-]+)/.exec(mail)![1]!;

  it("emails a link at sign-up; until it's opened, numbers, WhatsApp, SIP, API keys and invitations wait", async () => {
    const at = mails.length;
    const owner = await registerOwner(app, "verify", { verified: false });
    const mail = await mailTo(owner.email, at, /verify-email#/);
    expect(mail).toMatch(/Subject: Confirm your email for Voice Agent Platform/);
    const me = await owner.client.get("/api/v1/auth/me");
    expect(me.json().user.emailVerified).toBe(false);

    // Setting up agents is fine; spending money or reaching people is not
    expect((await owner.client.get("/api/v1/phone-numbers")).statusCode).toBe(200);
    const blocked = [
      await owner.client.post("/api/v1/phone-numbers/twilio/buy", { phoneNumber: "+12025550100" }),
      await owner.client.post("/api/v1/whatsapp/connect/manual", {
        accessToken: "biz-token-verify-0123456789",
        wabaId: "123456789012345",
        phoneNumberId: "123456789012346",
      }),
      await owner.client.post("/api/v1/sip-trunks", { name: "PBX" }),
      await owner.client.post("/api/v1/api-keys", { name: "crm", scopes: ["tenant:read"] }),
      await owner.client.post("/api/v1/invitations", {
        email: uniqueEmail("team"),
        roleId: await roleId(owner, "MANAGER"),
      }),
    ];
    for (const res of blocked) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    }

    // Sending again replaces the link
    const again = mails.length;
    const resent = await owner.client.post("/api/v1/auth/verify-email/resend", {});
    expect(resent.statusCode).toBe(202);
    expect(resent.json()).toEqual({ sent: true });
    const token = tokenIn(await mailTo(owner.email, again, /verify-email#/));
    expect(token).not.toBe(tokenIn(mail));
    const verify = (t: string) => new Client(app).post("/api/v1/auth/verify-email", { token: t });
    expect((await verify(tokenIn(mail))).json()).toMatchObject({ code: "TOKEN_EXPIRED" });

    // Opened in any browser (no session needed), once
    expect((await verify(token)).statusCode).toBe(204);
    expect((await verify(token)).json()).toMatchObject({ code: "TOKEN_EXPIRED" });
    expect((await owner.client.get("/api/v1/auth/me")).json().user.emailVerified).toBe(true);
    const key = await owner.client.post("/api/v1/api-keys", { name: "crm", scopes: ["tenant:read"] });
    expect(key.statusCode).toBe(201);
    expect(await owner.client.post("/api/v1/auth/verify-email/resend", {}).then((r) => r.json())).toEqual({
      sent: false,
      alreadyVerified: true,
    });
    const audit = await owner.client.get("/api/v1/audit-logs");
    expect(audit.json().items.map((e: { action: string }) => e.action)).toContain("user.email_verified");
  });

  it("an accepted invitation or a password reset proves the address too", async () => {
    const owner = await registerOwner(app, "verify-team");
    const email = uniqueEmail("teammate");
    const invite = await owner.client.post("/api/v1/invitations", {
      email,
      roleId: await roleId(owner, "MANAGER"),
    });
    const token = String(invite.json().inviteUrl).split("/invite/")[1];
    const joined = await new Client(app).post("/api/v1/invitations/accept", {
      token,
      name: "Teammate",
      password: STRONG_PASSWORD,
      acceptTerms: true,
    });
    expect(joined.json().user.emailVerified).toBe(true);

    const other = await registerOwner(app, "verify-reset", { verified: false });
    const at = mails.length;
    await new Client(app).post("/api/v1/auth/password/forgot", { email: other.email });
    const reset = /\/reset-password#([A-Za-z0-9_-]+)/.exec(
      await mailTo(other.email, at, /reset-password#/),
    )![1]!;
    await new Client(app).post("/api/v1/auth/password/reset", { token: reset, password: "N3w-Passw0rd!!" });
    const login = new Client(app);
    await login.post("/api/v1/auth/login", { email: other.email, password: "N3w-Passw0rd!!" });
    expect((await login.get("/api/v1/auth/me")).json().user.emailVerified).toBe(true);
  });

  it("EMAIL_VERIFICATION=off: installs without email aren't held back", async () => {
    const off = await createTestApp({ EMAIL_VERIFICATION: "off" });
    try {
      const owner = await registerOwner(off, "verify-off", { verified: false });
      expect((await owner.client.get("/api/v1/auth/me")).json().user.emailVerified).toBe(true);
      expect(
        (await owner.client.post("/api/v1/api-keys", { name: "crm", scopes: ["tenant:read"] })).statusCode,
      ).toBe(201);
    } finally {
      await off.close();
    }
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
