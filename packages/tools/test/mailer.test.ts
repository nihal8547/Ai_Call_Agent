import { describe, expect, it, vi } from "vitest";
import { deliverMail, emailFromIdToken, exchangeMicrosoftCode, microsoftAuthUrl, verifyMail } from "../src";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const idToken = (claims: Record<string, unknown>) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

describe("email through Google (Gmail API)", () => {
  it("sends as the signed-in account, with an encoded Arabic subject", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      if (String(url).includes("oauth2.googleapis.com/token"))
        return json({ access_token: "g-access", expires_in: 3600 });
      return json({ id: "msg-1" });
    });
    const r = await deliverMail(
      { kind: "google_oauth", refreshToken: "g-refresh-1", email: "owner@clinic.qa" },
      { from: "ignored@x.com", fromName: "عيادة الابتسامة", defaultTo: [] },
      { to: ["staff@clinic.qa"], subject: "مكالمة جديدة", text: "Caller: +97455123456" },
      {
        allowPrivateNetwork: false,
        timeoutMs: 1000,
        idempotencyKey: "call-1:step",
        google: {
          fetch: fetchMock as unknown as typeof fetch,
          timeoutMs: 1000,
          oauthClient: { clientId: "c", clientSecret: "s" },
        },
      },
    );
    expect(r.messageId).toBe("msg-1");
    const send = calls.find((c) => c.url.includes("gmail.googleapis.com"))!;
    const raw = Buffer.from(JSON.parse(send.body).raw as string, "base64url").toString("utf8");
    expect(raw).toContain("From: =?UTF-8?B?");
    expect(raw).toContain("<owner@clinic.qa>");
    expect(raw).toContain("To: staff@clinic.qa");
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from("مكالمة جديدة").toString("base64")}?=`);
    expect(raw).toContain("X-Idempotency-Key: call-1:step");
    const body = raw.split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Caller: +97455123456");
    // The refresh token is exchanged for an access token with the Gmail scope
    expect(calls[0]!.body).toContain("refresh_token=g-refresh-1");
  });
});

describe("email through Microsoft (Outlook / Microsoft 365)", () => {
  it("sends through Graph and saves a rotated refresh token", async () => {
    const calls: { url: string; body: string; auth: string }[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: String(init?.body ?? ""),
        auth: String((init?.headers as Record<string, string> | undefined)?.authorization ?? ""),
      });
      if (String(url).endsWith("/token"))
        return json({ access_token: "ms-access", refresh_token: "ms-refresh-2", expires_in: 3600 });
      return new Response(null, { status: 202 });
    });
    const rotated: string[] = [];
    await deliverMail(
      { kind: "microsoft_oauth", refreshToken: "ms-refresh-1", email: "owner@contoso.com" },
      { from: "owner@contoso.com", defaultTo: [] },
      { to: ["a@contoso.com", "b@contoso.com"], subject: "New call", text: "Details" },
      {
        allowPrivateNetwork: false,
        timeoutMs: 1000,
        idempotencyKey: "k1",
        microsoft: {
          fetch: fetchMock as unknown as typeof fetch,
          timeoutMs: 1000,
          oauthClient: { clientId: "c", clientSecret: "s" },
          onRefreshToken: (t) => void rotated.push(t),
        },
      },
    );
    expect(calls[0]!.url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(calls[0]!.body).toContain("grant_type=refresh_token");
    expect(calls[0]!.body).toContain("Mail.Send");
    const send = calls[1]!;
    expect(send.url).toBe("https://graph.microsoft.com/v1.0/me/sendMail");
    expect(send.auth).toBe("Bearer ms-access");
    expect(JSON.parse(send.body)).toMatchObject({
      message: {
        subject: "New call",
        body: { contentType: "Text", content: "Details" },
        toRecipients: [
          { emailAddress: { address: "a@contoso.com" } },
          { emailAddress: { address: "b@contoso.com" } },
        ],
        internetMessageHeaders: [{ name: "X-Idempotency-Key", value: "k1" }],
      },
      saveToSentItems: true,
    });
    expect(rotated).toEqual(["ms-refresh-2"]);
  });

  it("reports a revoked connection as needing sign-in again", async () => {
    const fetchMock = vi.fn(async () => json({ error: "invalid_grant" }, 400));
    await expect(
      verifyMail(
        { kind: "microsoft_oauth", refreshToken: "revoked", email: "x@y.com" },
        {
          allowPrivateNetwork: false,
          timeoutMs: 1000,
          microsoft: {
            fetch: fetchMock as unknown as typeof fetch,
            timeoutMs: 1000,
            oauthClient: { clientId: "c", clientSecret: "s" },
          },
        },
      ),
    ).rejects.toMatchObject({ kind: "auth" });
  });

  it("builds the sign-in link and reads the account from the ID token", async () => {
    const url = new URL(
      microsoftAuthUrl({
        clientId: "cid",
        redirectUri: "https://app.test/cb",
        scope: "offline_access Mail.Send",
        state: "st",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "cid",
      response_type: "code",
      redirect_uri: "https://app.test/cb",
      state: "st",
      prompt: "select_account",
    });
    expect(emailFromIdToken(idToken({ preferred_username: "Owner@Contoso.com" }))).toBe("owner@contoso.com");
    expect(emailFromIdToken("garbage")).toBeUndefined();

    const fetchMock = vi.fn(async () =>
      json({ access_token: "a", refresh_token: "r", id_token: idToken({ email: "me@outlook.com" }) }),
    );
    await expect(
      exchangeMicrosoftCode("code", "https://app.test/cb", "offline_access Mail.Send", {
        fetch: fetchMock as unknown as typeof fetch,
        timeoutMs: 1000,
        oauthClient: { clientId: "c", clientSecret: "s" },
      }),
    ).resolves.toEqual({ refreshToken: "r", email: "me@outlook.com" });
  });
});
