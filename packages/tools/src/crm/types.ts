import { ToolError, kindForStatus } from "../errors";

export type CrmProvider = "HUBSPOT" | "ZOHO";

export { ZOHO_ACCOUNTS_SERVERS } from "@platform/shared";

export type CrmCredentials =
  | { kind: "private_app"; token: string }
  | { kind: "oauth"; refreshToken: string; accountsServer?: string }
  /** Zoho "Self Client": the business's own client id/secret and a refresh token it generated */
  | {
      kind: "self_client";
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      accountsServer: string;
    };

export type CrmDeps = {
  fetch: typeof fetch;
  timeoutMs: number;
  /** The platform's OAuth app for this provider (needed for kind "oauth") */
  oauthClient?: { clientId: string; clientSecret: string };
};

/** A CRM property/field that answers can be written to */
export type CrmProperty = {
  name: string;
  label: string;
  /** Normalised: string, number, date, datetime, bool, enum, multienum, phone, email */
  type: "string" | "number" | "date" | "datetime" | "bool" | "enum" | "multienum" | "phone" | "email";
  options?: { label: string; value: string }[];
  required?: boolean;
};

/** One lead as the CRM should see it: fixed contact details plus mapped answers */
export type CrmRecord = {
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  /** property name → value, already converted for the CRM */
  properties: Record<string, string | number | boolean | string[]>;
};

/** fetch with a timeout; transport problems become retryable tool errors */
export async function crmFetch(
  deps: CrmDeps,
  what: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await deps.fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(deps.timeoutMs) });
  } catch (err) {
    const timeout = (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError";
    throw new ToolError(
      timeout ? "timeout" : "unavailable",
      timeout ? `${what} did not answer in time` : `Could not reach ${what}`,
    );
  }
}

/** Turn a failed response into a ToolError with the provider's own message */
export async function crmError(what: string, res: Response): Promise<ToolError> {
  const body = (await res.json().catch(() => ({}))) as {
    message?: string;
    error?: string;
    code?: string;
    data?: { message?: string }[];
  };
  const detail = body.message ?? body.data?.[0]?.message ?? body.error ?? body.code ?? `HTTP ${res.status}`;
  return new ToolError(kindForStatus(res.status), `${what}: ${String(detail).slice(0, 200)}`);
}

/** Short-lived access tokens, per credential (memory only) */
export const tokenCache = new Map<string, { token: string; apiDomain?: string; expiresAt: number }>();
