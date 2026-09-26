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

export const HUBSPOT_API = "https://api.hubapi.com";
export const HUBSPOT_SCOPES =
  "crm.objects.contacts.read crm.objects.contacts.write crm.schemas.contacts.read";

export function hubspotAuthUrl(o: { clientId: string; redirectUri: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    scope: HUBSPOT_SCOPES,
    state: o.state,
  });
  return `https://app.hubspot.com/oauth/authorize?${q}`;
}

async function tokenRequest(deps: CrmDeps, body: URLSearchParams) {
  const res = await crmFetch(deps, "HubSpot", `${HUBSPOT_API}/oauth/v1/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    message?: string;
    status?: string;
  };
  if (!res.ok || !json.access_token)
    throw new ToolError(
      res.status >= 500 ? "unavailable" : "auth",
      `HubSpot refused the connection (${json.status ?? json.message ?? res.status})`,
    );
  return json;
}

export async function exchangeHubspotCode(code: string, redirectUri: string, deps: CrmDeps): Promise<string> {
  if (!deps.oauthClient) throw new ToolError("config", "HubSpot sign-in is not configured on this platform");
  const json = await tokenRequest(
    deps,
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: deps.oauthClient.clientId,
      client_secret: deps.oauthClient.clientSecret,
      redirect_uri: redirectUri,
      code,
    }),
  );
  if (!json.refresh_token) throw new ToolError("auth", "HubSpot did not return a refresh token");
  return json.refresh_token;
}

async function accessToken(creds: CrmCredentials, deps: CrmDeps): Promise<string> {
  if (creds.kind === "private_app") return creds.token;
  if (creds.kind !== "oauth") throw new ToolError("config", "Unsupported HubSpot credentials");
  if (!deps.oauthClient) throw new ToolError("config", "HubSpot sign-in is not configured on this platform");
  const key = createHash("sha256").update(`hubspot:${creds.refreshToken}`).digest("hex");
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
  const json = await tokenRequest(
    deps,
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: deps.oauthClient.clientId,
      client_secret: deps.oauthClient.clientSecret,
      refresh_token: creds.refreshToken,
    }),
  );
  tokenCache.set(key, {
    token: json.access_token!,
    expiresAt: Date.now() + (json.expires_in ?? 1800) * 1000,
  });
  return json.access_token!;
}

async function call(creds: CrmCredentials, deps: CrmDeps, method: string, path: string, body?: unknown) {
  const token = await accessToken(creds, deps);
  return crmFetch(deps, "HubSpot", `${HUBSPOT_API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

type HubspotProperty = {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  options?: { label: string; value: string; hidden?: boolean }[];
  hidden?: boolean;
  calculated?: boolean;
  modificationMetadata?: { readOnlyValue?: boolean };
};

function normalise(p: HubspotProperty): CrmProperty["type"] {
  if (p.type === "enumeration")
    return p.fieldType === "checkbox" && p.options && p.options.length > 1
      ? "multienum"
      : p.fieldType === "booleancheckbox"
        ? "bool"
        : "enum";
  if (p.type === "bool") return "bool";
  if (p.type === "number") return "number";
  if (p.type === "date") return "date";
  if (p.type === "datetime") return "datetime";
  if (p.fieldType === "phonenumber") return "phone";
  return "string";
}

/** Writable contact properties (for the mapping screen) */
export async function hubspotProperties(creds: CrmCredentials, deps: CrmDeps): Promise<CrmProperty[]> {
  const res = await call(creds, deps, "GET", "/crm/v3/properties/contacts");
  if (!res.ok) throw await crmError("HubSpot", res);
  const json = (await res.json()) as { results: HubspotProperty[] };
  return json.results
    .filter((p) => !p.hidden && !p.calculated && !p.modificationMetadata?.readOnlyValue)
    .map((p) => ({
      name: p.name,
      label: p.label,
      type: normalise(p),
      ...(p.options?.length
        ? { options: p.options.filter((o) => !o.hidden).map((o) => ({ label: o.label, value: o.value })) }
        : {}),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

async function findContact(creds: CrmCredentials, deps: CrmDeps, r: CrmRecord): Promise<string | null> {
  const groups = [
    ...(r.email ? [{ filters: [{ propertyName: "email", operator: "EQ", value: r.email }] }] : []),
    ...(r.phone ? [{ filters: [{ propertyName: "phone", operator: "EQ", value: r.phone }] }] : []),
  ];
  if (!groups.length) return null;
  const res = await call(creds, deps, "POST", "/crm/v3/objects/contacts/search", {
    filterGroups: groups,
    properties: ["email", "phone"],
    limit: 1,
  });
  if (!res.ok) throw await crmError("HubSpot", res);
  const json = (await res.json()) as { results: { id: string }[] };
  return json.results[0]?.id ?? null;
}

/**
 * Create or update the caller as a HubSpot contact: by the id from a previous sync, else by email
 * or phone, else new. Returns the contact id.
 */
export async function hubspotUpsertContact(
  creds: CrmCredentials,
  deps: CrmDeps,
  r: CrmRecord,
  knownId: string | null,
): Promise<string> {
  const properties: Record<string, string> = {};
  if (r.firstName) properties.firstname = r.firstName;
  if (r.lastName) properties.lastname = r.lastName;
  if (r.phone) properties.phone = r.phone;
  if (r.email) properties.email = r.email;
  for (const [k, v] of Object.entries(r.properties))
    properties[k] = Array.isArray(v) ? v.join(";") : String(v);

  const id = knownId ?? (await findContact(creds, deps, r));
  if (id) {
    const res = await call(creds, deps, "PATCH", `/crm/v3/objects/contacts/${encodeURIComponent(id)}`, {
      properties,
    });
    if (res.ok) return id;
    // Deleted in HubSpot since the last sync: create it again
    if (res.status !== 404) throw await crmError("HubSpot", res);
  }
  const res = await call(creds, deps, "POST", "/crm/v3/objects/contacts", { properties });
  if (res.status === 409) {
    // Someone created the same email in between: update that one
    const existing = await findContact(creds, deps, r);
    if (existing) return hubspotUpsertContact(creds, deps, r, existing);
  }
  if (!res.ok) throw await crmError("HubSpot", res);
  return ((await res.json()) as { id: string }).id;
}

/** Connection test: can we read contacts' properties? */
export async function checkHubspot(creds: CrmCredentials, deps: CrmDeps): Promise<string> {
  const props = await hubspotProperties(creds, deps);
  return `Connected to HubSpot (${props.length} contact properties)`;
}
