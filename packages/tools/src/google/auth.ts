import { createHash, createSign } from "node:crypto";
import { ToolError, kindForStatus } from "../errors";
import { emailFromIdToken } from "../microsoft";

export type GoogleCredentials =
  | { kind: "service_account"; clientEmail: string; privateKey: string }
  | { kind: "oauth"; refreshToken: string };

export type GoogleDeps = {
  fetch: typeof fetch;
  /** Needed for OAuth-connected integrations */
  oauthClient?: { clientId: string; clientSecret: string };
  timeoutMs: number;
};

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SCOPES = {
  calendar:
    "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly",
  sheets: "https://www.googleapis.com/auth/spreadsheets",
  /** Send email as the signed-in Gmail / Google Workspace account; openid email = which account */
  gmail: "https://www.googleapis.com/auth/gmail.send openid email",
} as const;

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Short-lived access tokens, cached per credential and scope (never persisted) */
const cache = new Map<string, { token: string; expiresAt: number }>();

export async function googleAccessToken(
  creds: GoogleCredentials,
  scope: string,
  deps: GoogleDeps,
): Promise<string> {
  const key = createHash("sha256")
    .update(JSON.stringify(creds) + scope)
    .digest("hex");
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;

  let body: URLSearchParams;
  if (creds.kind === "service_account") {
    const iat = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(
      JSON.stringify({ iss: creds.clientEmail, scope, aud: GOOGLE_TOKEN_URL, iat, exp: iat + 3600 }),
    );
    let signature: string;
    try {
      signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(creds.privateKey, "base64url");
    } catch {
      throw new ToolError("auth", "The service account key is not a valid private key");
    }
    body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    });
  } else {
    if (!deps.oauthClient) throw new ToolError("config", "Google sign-in is not configured on this platform");
    body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
      client_id: deps.oauthClient.clientId,
      client_secret: deps.oauthClient.clientSecret,
    });
  }

  const res = await googleFetch(deps, GOOGLE_TOKEN_URL, {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!res.ok || !json.access_token) {
    // invalid_grant = revoked consent or deleted key: staff must reconnect
    const kind =
      json.error === "invalid_grant" || res.status === 400 || res.status === 401
        ? "auth"
        : kindForStatus(res.status);
    throw new ToolError(kind, `Google refused the credentials (${json.error ?? res.status})`);
  }
  cache.set(key, { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 });
  return json.access_token;
}

/** Exchange an OAuth authorization code for a refresh token */
export async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
  deps: GoogleDeps,
): Promise<string> {
  return (await exchangeGoogleCodeWithEmail(code, redirectUri, deps)).refreshToken;
}

/** Same, plus the account's email when the "email" scope was granted (from the ID token) */
export async function exchangeGoogleCodeWithEmail(
  code: string,
  redirectUri: string,
  deps: GoogleDeps,
): Promise<{ refreshToken: string; email: string | undefined }> {
  if (!deps.oauthClient) throw new ToolError("config", "Google sign-in is not configured on this platform");
  const res = await googleFetch(deps, GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: deps.oauthClient.clientId,
      client_secret: deps.oauthClient.clientSecret,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    refresh_token?: string;
    id_token?: string;
    error?: string;
  };
  if (!res.ok || !json.refresh_token)
    throw new ToolError("auth", `Google sign-in failed (${json.error ?? "no refresh token"})`);
  return { refreshToken: json.refresh_token, email: emailFromIdToken(json.id_token) };
}

export function googleAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
}): string {
  const q = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: opts.scope,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: opts.state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

/** fetch with a timeout; network failures become retryable tool errors */
export async function googleFetch(deps: GoogleDeps, url: string, init: RequestInit): Promise<Response> {
  try {
    return await deps.fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(deps.timeoutMs) });
  } catch (err) {
    const timeout = (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError";
    throw new ToolError(
      timeout ? "timeout" : "unavailable",
      timeout ? "Google did not answer in time" : "Could not reach Google",
    );
  }
}

/** Authorised JSON call to a Google API */
export async function googleJson<T>(
  deps: GoogleDeps,
  token: string,
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; data: T }> {
  const res = await googleFetch(deps, url, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const data = (res.status === 204 ? {} : await res.json().catch(() => ({}))) as T & {
    error?: { message?: string };
  };
  return { status: res.status, data };
}

export function googleError(status: number, data: unknown, what: string): ToolError {
  const msg = (data as { error?: { message?: string } })?.error?.message;
  return new ToolError(kindForStatus(status), `${what}: ${msg ?? `HTTP ${status}`}`.slice(0, 300));
}
