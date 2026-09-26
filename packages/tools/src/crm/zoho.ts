import { createHash } from "node:crypto";
import { ToolError } from "../errors";
import {
  type CrmCredentials,
  type CrmDeps,
  crmError,
  crmFetch,
  type CrmProperty,
  type CrmRecord,
  tokenCache,
} from "./types";
import { ZOHO_ACCOUNTS_SERVERS } from "@platform/shared";

export const ZOHO_SCOPES = "ZohoCRM.modules.leads.ALL,ZohoCRM.settings.fields.READ";

const accountsServer = (s: string | undefined) => {
  const server = s ?? "https://accounts.zoho.com";
  if (!(ZOHO_ACCOUNTS_SERVERS as readonly string[]).includes(server))
    throw new ToolError("config", "Unknown Zoho data center");
  return server;
};

export function zohoAuthUrl(o: { clientId: string; redirectUri: string; state: string }): string {
  const q = new URLSearchParams({
    scope: ZOHO_SCOPES,
    client_id: o.clientId,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    redirect_uri: o.redirectUri,
    state: o.state,
  });
  // The global accounts server sends the user on to their own data center
  return `https://accounts.zoho.com/oauth/v2/auth?${q}`;
}

async function tokenRequest(deps: CrmDeps, server: string, params: Record<string, string>) {
  const res = await crmFetch(deps, "Zoho", `${server}/oauth/v2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    api_domain?: string;
    expires_in?: number;
    error?: string;
  };
  if (!res.ok || !json.access_token)
    throw new ToolError(
      res.status >= 500 ? "unavailable" : "auth",
      `Zoho refused the connection (${json.error ?? res.status})`,
    );
  return json;
}

/** OAuth callback: Zoho says which data center the user is in (accounts-server) */
export async function exchangeZohoCode(
  code: string,
  redirectUri: string,
  server: string,
  deps: CrmDeps,
): Promise<{ refreshToken: string; accountsServer: string }> {
  if (!deps.oauthClient) throw new ToolError("config", "Zoho sign-in is not configured on this platform");
  const accounts = accountsServer(server);
  const json = await tokenRequest(deps, accounts, {
    grant_type: "authorization_code",
    client_id: deps.oauthClient.clientId,
    client_secret: deps.oauthClient.clientSecret,
    redirect_uri: redirectUri,
    code,
  });
  if (!json.refresh_token) throw new ToolError("auth", "Zoho did not return a refresh token");
  return { refreshToken: json.refresh_token, accountsServer: accounts };
}

async function session(creds: CrmCredentials, deps: CrmDeps): Promise<{ token: string; apiDomain: string }> {
  let client: { clientId: string; clientSecret: string };
  let server: string;
  if (creds.kind === "self_client") {
    client = { clientId: creds.clientId, clientSecret: creds.clientSecret };
    server = accountsServer(creds.accountsServer);
  } else if (creds.kind === "oauth") {
    if (!deps.oauthClient) throw new ToolError("config", "Zoho sign-in is not configured on this platform");
    client = deps.oauthClient;
    server = accountsServer(creds.accountsServer);
  } else throw new ToolError("config", "Unsupported Zoho credentials");

  const key = createHash("sha256").update(`zoho:${client.clientId}:${creds.refreshToken}`).digest("hex");
  const hit = tokenCache.get(key);
  if (hit?.apiDomain && hit.expiresAt > Date.now() + 60_000)
    return { token: hit.token, apiDomain: hit.apiDomain };
  const json = await tokenRequest(deps, server, {
    grant_type: "refresh_token",
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: creds.refreshToken,
  });
  // The API domain must be Zoho's own (it decides where lead data is sent)
  const apiDomain = json.api_domain ?? "https://www.zohoapis.com";
  if (!/^https:\/\/(www\.)?zohoapis\.[a-z.]+$/.test(apiDomain))
    throw new ToolError("config", "Unexpected Zoho API domain");
  tokenCache.set(key, {
    token: json.access_token!,
    apiDomain,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  });
  return { token: json.access_token!, apiDomain };
}

async function call(creds: CrmCredentials, deps: CrmDeps, method: string, path: string, body?: unknown) {
  const s = await session(creds, deps);
  return crmFetch(deps, "Zoho CRM", `${s.apiDomain}${path}`, {
    method,
    headers: { authorization: `Zoho-oauthtoken ${s.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

type ZohoField = {
  api_name: string;
  field_label: string;
  data_type: string;
  read_only?: boolean;
  field_read_only?: boolean;
  system_mandatory?: boolean;
  pick_list_values?: { display_value: string; actual_value: string }[];
};

const TYPES: Record<string, CrmProperty["type"]> = {
  text: "string",
  textarea: "string",
  integer: "number",
  bigint: "number",
  double: "number",
  currency: "number",
  percent: "number",
  date: "date",
  datetime: "datetime",
  boolean: "bool",
  picklist: "enum",
  multiselectpicklist: "multienum",
  phone: "phone",
  email: "email",
};

/** Writable fields of the Leads module */
export async function zohoFields(creds: CrmCredentials, deps: CrmDeps): Promise<CrmProperty[]> {
  const res = await call(creds, deps, "GET", "/crm/v6/settings/fields?module=Leads");
  if (!res.ok) throw await crmError("Zoho CRM", res);
  const json = (await res.json()) as { fields: ZohoField[] };
  return json.fields
    .filter((f) => !f.read_only && !f.field_read_only && TYPES[f.data_type])
    .map((f) => ({
      name: f.api_name,
      label: f.field_label,
      type: TYPES[f.data_type]!,
      ...(f.pick_list_values?.length
        ? {
            options: f.pick_list_values
              .filter((o) => o.actual_value !== "-None-")
              .map((o) => ({ label: o.display_value, value: o.actual_value })),
          }
        : {}),
      ...(f.system_mandatory ? { required: true } : {}),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

type ZohoResult = { code: string; status: string; message: string; details?: { id?: string } };

/** Create or update the caller as a Zoho lead (matched by the previous sync's id, else by phone) */
export async function zohoUpsertLead(
  creds: CrmCredentials,
  deps: CrmDeps,
  r: CrmRecord,
  knownId: string | null,
): Promise<string> {
  const record: Record<string, unknown> = {
    // Last name is required by Zoho; a caller who never gave a name is still a lead
    Last_Name: r.lastName ?? r.firstName ?? (r.phone ? `Caller ${r.phone}` : "Caller"),
    ...(r.lastName && r.firstName ? { First_Name: r.firstName } : {}),
    ...(r.phone ? { Phone: r.phone } : {}),
    ...(r.email ? { Email: r.email } : {}),
    Lead_Source: "Phone call",
    ...r.properties,
  };
  let res: Response;
  if (knownId) {
    res = await call(creds, deps, "PUT", `/crm/v6/Leads/${encodeURIComponent(knownId)}`, { data: [record] });
    if (res.ok) return knownId;
    if (res.status !== 404 && res.status !== 400) throw await crmError("Zoho CRM", res);
  }
  res = await call(creds, deps, "POST", "/crm/v6/Leads/upsert", {
    data: [record],
    duplicate_check_fields: r.email ? ["Email", "Phone"] : ["Phone"],
  });
  const json = (await res.json().catch(() => ({}))) as { data?: ZohoResult[] };
  const first = json.data?.[0];
  if (!res.ok || !first || first.status !== "success" || !first.details?.id)
    throw new ToolError(
      res.status === 401 ? "auth" : res.status >= 500 ? "unavailable" : "rejected",
      `Zoho CRM: ${first?.message ?? `HTTP ${res.status}`}`.slice(0, 250),
    );
  return first.details.id;
}

export async function checkZoho(creds: CrmCredentials, deps: CrmDeps): Promise<string> {
  const fields = await zohoFields(creds, deps);
  return `Connected to Zoho CRM (${fields.length} lead fields)`;
}
