import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TenantDbService } from "../src/infra/tenant-db.service";
import { Client, createTestApp, hasTestDb, registerOwner } from "./support/app";

// ── Fake Google and Microsoft behind fetch; everything else goes to the network ─────
type Seen = { url: URL; body: string; auth: string };
const seen: Seen[] = [];
const idToken = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
let msRefresh = 0;
const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function installFakes() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body =
      typeof init.body === "string"
        ? init.body
        : init.body instanceof URLSearchParams
          ? init.body.toString()
          : "";
    const auth = String((init.headers as Record<string, string> | undefined)?.authorization ?? "");
    if (url.hostname === "oauth2.googleapis.com") {
      seen.push({ url, body, auth });
      const p = new URLSearchParams(body);
      if (p.get("grant_type") === "authorization_code")
        return json({
          access_token: "g-at",
          refresh_token: "g-rt",
          id_token: idToken({ email: "owner@gmail.com" }),
        });
      return json({ access_token: "g-at-2", expires_in: 3600 });
    }
    if (url.hostname === "login.microsoftonline.com") {
      seen.push({ url, body, auth });
      const p = new URLSearchParams(body);
      if (p.get("grant_type") === "authorization_code")
        return json({
          access_token: "m-at",
          refresh_token: "m-rt-0",
          id_token: idToken({ preferred_username: "Owner@Contoso.com" }),
        });
      // Microsoft rotates refresh tokens on every use
      msRefresh += 1;
      return json({
        access_token: `m-at-${msRefresh}`,
        refresh_token: `m-rt-${msRefresh}`,
        expires_in: 3600,
      });
    }
    return realFetch(input, init);
  });
}

describe.skipIf(!hasTestDb)("email by signing in with Google or Microsoft", () => {
  let app: NestFastifyApplication;
  let owner: Awaited<ReturnType<typeof registerOwner>>;
  const db = () => app.get(TenantDbService).db(owner.me.tenant.id);

  beforeAll(async () => {
    app = await createTestApp({
      GOOGLE_OAUTH_CLIENT_ID: "google-client-id.apps.googleusercontent.com",
      GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
      MICROSOFT_CLIENT_ID: "11111111-2222-3333-4444-555555555555",
      MICROSOFT_CLIENT_SECRET: "microsoft-client-secret",
    });
    owner = await registerOwner(app, "oauthmail");
  });
  beforeEach(() => installFakes());
  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
  });

  it("offers both sign-ins", async () => {
    const list = (await owner.client.get("/api/v1/integrations")).json();
    expect(list).toMatchObject({ googleOAuth: true, microsoftOAuth: true });
  });

  it("Connect with Google (Gmail): sign in, come back connected, send-only scope", async () => {
    const config = JSON.stringify({ defaultTo: ["staff@clinic.test"], fromName: "Front desk" });
    const start = await owner.client.get(
      `/api/v1/integrations/oauth/google/start?${new URLSearchParams({ type: "EMAIL_SMTP", name: "Office Gmail", config })}`,
    );
    expect(start.statusCode).toBe(200);
    const url = new URL(start.json().url);
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.send openid email");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/v1/integrations/oauth/google/callback",
    );

    // Google sends the browser back with a code
    const done = await owner.client.get(
      `/api/v1/integrations/oauth/google/callback?state=${url.searchParams.get("state")}&code=good-code`,
    );
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toMatch(/\/integrations\?connected=/);

    const row = await db().integration.findFirstOrThrow({ where: { name: "Office Gmail" } });
    expect(row).toMatchObject({ type: "EMAIL_SMTP", status: "CONNECTED" });
    expect(row.config).toMatchObject({
      from: "owner@gmail.com",
      fromName: "Front desk",
      defaultTo: ["staff@clinic.test"],
      auth: "oauth",
      provider: "google",
      account: "owner@gmail.com",
    });
    // Tokens are sealed, never readable in the row
    expect(Buffer.from(row.credentialsEncrypted).toString("latin1")).not.toContain("g-rt");

    const test = await owner.client.post(`/api/v1/integrations/${row.id}/test`);
    expect(test.json()).toEqual({ ok: true, message: "Connected to Gmail as owner@gmail.com" });
    const refresh = seen.filter((s) => s.url.hostname === "oauth2.googleapis.com").at(-1)!;
    expect(new URLSearchParams(refresh.body).get("refresh_token")).toBe("g-rt");
  });

  it("Connect with Microsoft (Outlook): sign in, come back connected, rotated tokens are kept", async () => {
    const config = JSON.stringify({ defaultTo: ["staff@contoso.com"] });
    const start = await owner.client.get(
      `/api/v1/integrations/oauth/microsoft/start?${new URLSearchParams({ name: "Office Outlook", config })}`,
    );
    const url = new URL(start.json().url);
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("scope")).toBe("offline_access openid email User.Read Mail.Send");
    expect(url.searchParams.get("client_id")).toBe("11111111-2222-3333-4444-555555555555");

    // Another browser can't finish this sign-in
    const forged = await new Client(app).get(
      `/api/v1/integrations/oauth/microsoft/callback?state=${url.searchParams.get("state")}&code=x`,
    );
    expect(forged.headers.location).toMatch(/\/login$/);

    const again = new URL(
      (
        await owner.client.get(
          `/api/v1/integrations/oauth/microsoft/start?${new URLSearchParams({ name: "Office Outlook", config })}`,
        )
      ).json().url,
    );
    const done = await owner.client.get(
      `/api/v1/integrations/oauth/microsoft/callback?state=${again.searchParams.get("state")}&code=good-code`,
    );
    expect(done.headers.location).toMatch(/\/integrations\?connected=/);
    const row = await db().integration.findFirstOrThrow({ where: { name: "Office Outlook" } });
    expect(row.config).toMatchObject({
      from: "owner@contoso.com",
      provider: "microsoft",
      account: "owner@contoso.com",
    });

    // Each test refreshes; the rotated refresh token is stored and used next time
    expect((await owner.client.post(`/api/v1/integrations/${row.id}/test`)).json()).toEqual({
      ok: true,
      message: "Connected to Outlook as owner@contoso.com",
    });
    const firstRefresh = new URLSearchParams(
      seen.filter((s) => s.url.hostname === "login.microsoftonline.com").at(-1)!.body,
    );
    expect(firstRefresh.get("refresh_token")).toBe("m-rt-0");
    expect((await owner.client.post(`/api/v1/integrations/${row.id}/test`)).json().ok).toBe(true);
    const secondRefresh = new URLSearchParams(
      seen.filter((s) => s.url.hostname === "login.microsoftonline.com").at(-1)!.body,
    );
    expect(secondRefresh.get("refresh_token")).toBe("m-rt-1");
  });

  it("says so when the person declines on the provider's page", async () => {
    const start = new URL(
      (
        await owner.client.get(
          `/api/v1/integrations/oauth/microsoft/start?${new URLSearchParams({
            name: "Declined",
            config: JSON.stringify({ defaultTo: ["a@b.com"] }),
          })}`,
        )
      ).json().url,
    );
    const back = await owner.client.get(
      `/api/v1/integrations/oauth/microsoft/callback?state=${start.searchParams.get("state")}&error=access_denied`,
    );
    expect(decodeURIComponent(back.headers.location as string).replace(/\+/g, " ")).toContain(
      "error=Microsoft access was not granted",
    );
    expect(await db().integration.count({ where: { name: "Declined" } })).toBe(0);
  });

  it("checks the settings before sending anyone to sign in", async () => {
    const bad = await owner.client.get(
      `/api/v1/integrations/oauth/google/start?${new URLSearchParams({
        type: "EMAIL_SMTP",
        name: "No recipients",
        config: JSON.stringify({ defaultTo: [] }),
      })}`,
    );
    expect(bad.statusCode).toBe(400);
  });
});
