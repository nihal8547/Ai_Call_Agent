import { createHash } from "node:crypto";
import { ToolError, kindForStatus } from "./errors";

/**
 * Microsoft identity platform (Entra ID) for Outlook / Microsoft 365, work and personal accounts
 * ("common" tenant). Used to send email as the signed-in mailbox through Microsoft Graph.
 */
export const MS_AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
export const MS_GRAPH = "https://graph.microsoft.com/v1.0";
export const MS_SCOPES = { mail: "offline_access openid email User.Read Mail.Send" } as const;

export type MicrosoftClient = { clientId: string; clientSecret: string };
export type MicrosoftDeps = {
  fetch: typeof fetch;
  oauthClient?: MicrosoftClient;
  timeoutMs: number;
  /** Microsoft rotates refresh tokens: save the newest one so the connection outlives the old */
  onRefreshToken?: (refreshToken: string) => Promise<void> | void;
};

export function microsoftAuthUrl(o: {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
}): string {
  const q = new URLSearchParams({
    client_id: o.clientId,
    response_type: "code",
    redirect_uri: o.redirectUri,
    response_mode: "query",
    scope: o.scope,
    state: o.state,
    prompt: "select_account",
  });
  return `${MS_AUTHORITY}/authorize?${q}`;
}

export async function msFetch(deps: MicrosoftDeps, url: string, init: RequestInit): Promise<Response> {
  try {
    return await deps.fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(deps.timeoutMs) });
  } catch (err) {
    const timeout = (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError";
    throw new ToolError(
      timeout ? "timeout" : "unavailable",
      timeout ? "Microsoft did not answer in time" : "Could not reach Microsoft",
    );
  }
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

async function token(deps: MicrosoftDeps, params: Record<string, string>): Promise<TokenResponse> {
  if (!deps.oauthClient)
    throw new ToolError("config", "Microsoft sign-in is not configured on this platform");
  const res = await msFetch(deps, `${MS_AUTHORITY}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: deps.oauthClient.clientId,
      client_secret: deps.oauthClient.clientSecret,
      ...params,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    const kind =
      json.error === "invalid_grant" || res.status === 400 || res.status === 401
        ? "auth"
        : kindForStatus(res.status);
    throw new ToolError(kind, `Microsoft refused the sign-in (${json.error ?? res.status})`);
  }
  return json;
}

/** The email address in an ID token received straight from the token endpoint (TLS, not a browser) */
export function emailFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      email?: string;
      preferred_username?: string;
    };
    const email = claims.email ?? claims.preferred_username;
    return email && /^[^@\s]+@[^@\s]+$/.test(email) ? email.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export async function exchangeMicrosoftCode(
  code: string,
  redirectUri: string,
  scope: string,
  deps: MicrosoftDeps,
): Promise<{ refreshToken: string; email: string | undefined }> {
  const json = await token(deps, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    scope,
  });
  if (!json.refresh_token) throw new ToolError("auth", "Microsoft did not allow offline access");
  let email = emailFromIdToken(json.id_token);
  if (!email) {
    const me = await msFetch(deps, `${MS_GRAPH}/me?$select=mail,userPrincipalName`, {
      headers: { authorization: `Bearer ${json.access_token}` },
    });
    const data = (await me.json().catch(() => ({}))) as { mail?: string; userPrincipalName?: string };
    email = (data.mail ?? data.userPrincipalName)?.toLowerCase();
  }
  return { refreshToken: json.refresh_token, email };
}

const cache = new Map<string, { token: string; expiresAt: number }>();

export async function microsoftAccessToken(
  refreshToken: string,
  scope: string,
  deps: MicrosoftDeps,
): Promise<string> {
  const key = createHash("sha256")
    .update(refreshToken + scope)
    .digest("hex");
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
  const json = await token(deps, { grant_type: "refresh_token", refresh_token: refreshToken, scope });
  cache.set(key, { token: json.access_token!, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 });
  if (json.refresh_token && json.refresh_token !== refreshToken)
    await deps.onRefreshToken?.(json.refresh_token);
  return json.access_token!;
}
