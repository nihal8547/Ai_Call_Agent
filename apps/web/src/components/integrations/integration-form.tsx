"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Check, TextArea } from "@/components/ui/inputs";
import { Alert } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import type { Integration } from "@/lib/types";
import { type ConnectableType, isCrm, spreadsheetIdFrom, ZOHO_DATA_CENTERS } from "./catalog";

/** Which "Connect with …" sign-ins this platform offers */
export type OAuthAvailability = { google: boolean; hubspot: boolean; zoho: boolean; microsoft: boolean };

type Provider = "google" | "microsoft" | "hubspot" | "zoho";
const PROVIDER_NAME: Record<Provider, string> = {
  google: "Google",
  microsoft: "Microsoft",
  hubspot: "HubSpot",
  zoho: "Zoho",
};
/** Which "Continue with …" sign-ins each integration offers */
const PROVIDERS: Record<ConnectableType, Provider[]> = {
  GOOGLE_CALENDAR: ["google"],
  GOOGLE_SHEETS: ["google"],
  EMAIL_SMTP: ["google", "microsoft"],
  WEBHOOK: [],
  HUBSPOT: ["hubspot"],
  ZOHO: ["zoho"],
};
const MANUAL_LABEL: Record<ConnectableType, string> = {
  GOOGLE_CALENDAR: "a Google service account key",
  GOOGLE_SHEETS: "a Google service account key",
  EMAIL_SMTP: "mail server (SMTP) details",
  WEBHOOK: "",
  HUBSPOT: "a private app token",
  ZOHO: "a Zoho Self Client",
};

const DEFAULT_NAME: Record<ConnectableType, string> = {
  GOOGLE_CALENDAR: "Appointments calendar",
  GOOGLE_SHEETS: "Leads sheet",
  EMAIL_SMTP: "Office email",
  WEBHOOK: "CRM webhook",
  HUBSPOT: "HubSpot",
  ZOHO: "Zoho CRM",
};

/** Connect a new integration, or edit one (credentials are replaced only when re-entered) */
export function IntegrationForm({
  type,
  existing,
  oauth,
  onSaved,
}: {
  type: ConnectableType;
  existing?: Integration;
  oauth: OAuthAvailability;
  onSaved: (i: Integration) => void;
}) {
  const cfg = (existing?.config ?? {}) as Record<string, unknown>;
  const [name, setName] = useState(existing?.name ?? DEFAULT_NAME[type]);
  // Google
  const [calendarId, setCalendarId] = useState(String(cfg.calendarId ?? "primary"));
  const [sheet, setSheet] = useState(String(cfg.spreadsheetId ?? ""));
  const [sheetName, setSheetName] = useState(String(cfg.sheetName ?? "Sheet1"));
  const [keyJson, setKeyJson] = useState("");
  // SMTP
  const [host, setHost] = useState(String(cfg.host ?? ""));
  const [port, setPort] = useState(String(cfg.port ?? "587"));
  const [secure, setSecure] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [from, setFrom] = useState(String(cfg.from ?? ""));
  const [fromName, setFromName] = useState(String(cfg.fromName ?? ""));
  const [defaultTo, setDefaultTo] = useState(Array.isArray(cfg.defaultTo) ? cfg.defaultTo.join(", ") : "");
  // Webhook
  const [url, setUrl] = useState(String(cfg.url ?? ""));
  const [secret, setSecret] = useState("");
  // CRMs
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [dataCenter, setDataCenter] = useState(String(cfg.dataCenter ?? ZOHO_DATA_CENTERS[0]!.server));

  const isGoogle = type === "GOOGLE_CALENDAR" || type === "GOOGLE_SHEETS";
  const providers = PROVIDERS[type];
  /** Sign-in first when creating; editing keeps the details form */
  const signInFirst = !existing && providers.length > 0;
  const [showManual, setShowManual] = useState(!signInFirst);
  const config = (): Record<string, unknown> => {
    switch (type) {
      case "GOOGLE_CALENDAR":
        return { calendarId: calendarId.trim() || "primary" };
      case "GOOGLE_SHEETS":
        return { spreadsheetId: spreadsheetIdFrom(sheet), sheetName: sheetName.trim() || "Sheet1" };
      case "EMAIL_SMTP":
        return {
          from: from.trim(),
          ...(fromName.trim() ? { fromName: fromName.trim() } : {}),
          defaultTo: defaultTo.split(/[,;\s]+/).filter(Boolean),
        };
      case "WEBHOOK":
        return { url: url.trim() };
      case "HUBSPOT":
      case "ZOHO":
        // The field mapping is edited on its own screen; keep it as it is
        return { syncLeads: cfg.syncLeads !== false, mapping: cfg.mapping ?? {} };
    }
  };
  const credentials = (): Record<string, unknown> | undefined => {
    switch (type) {
      case "GOOGLE_CALENDAR":
      case "GOOGLE_SHEETS":
        return keyJson.trim() ? { kind: "service_account", json: keyJson.trim() } : undefined;
      case "EMAIL_SMTP":
        return host.trim() && (!existing || password)
          ? {
              host: host.trim(),
              port: Number(port) || 587,
              secure,
              ...(username ? { username } : {}),
              ...(password ? { password } : {}),
            }
          : undefined;
      case "WEBHOOK":
        return secret ? { secret } : existing ? undefined : {};
      case "HUBSPOT":
        return token.trim() ? { kind: "private_app", token: token.trim() } : undefined;
      case "ZOHO":
        return clientId.trim() || clientSecret.trim() || refreshToken.trim()
          ? {
              kind: "self_client",
              clientId: clientId.trim(),
              clientSecret: clientSecret.trim(),
              refreshToken: refreshToken.trim(),
              accountsServer: dataCenter,
            }
          : undefined;
    }
  };

  const save = useMutation({
    mutationFn: () => {
      const creds = credentials();
      return existing
        ? api<Integration>(`/integrations/${existing.id}`, {
            method: "PATCH",
            body: { name, config: config(), ...(creds ? { credentials: creds } : {}) },
          })
        : api<Integration>("/integrations", {
            method: "POST",
            body: { type, name, config: config(), credentials: creds ?? {} },
          });
    },
    onSuccess: onSaved,
  });
  const signIn = useMutation({
    mutationFn: (provider: Provider) => {
      if (provider === "hubspot" || provider === "zoho")
        return api<{ url: string }>(`/integrations/oauth/${provider}/start?${new URLSearchParams({ name })}`);
      // Email that signs in sends as that account: only the recipients and a display name are ours
      const settings =
        type === "EMAIL_SMTP"
          ? {
              defaultTo: defaultTo.split(/[,;\s]+/).filter(Boolean),
              ...(fromName.trim() ? { fromName: fromName.trim() } : {}),
            }
          : config();
      const q = new URLSearchParams({ name, config: JSON.stringify(settings) });
      if (provider === "google") q.set("type", type);
      return api<{ url: string }>(`/integrations/oauth/${provider}/start?${q}`);
    },
    // Off to the provider's page; it sends the browser back here, connected
    onSuccess: ({ url }) => window.location.assign(url),
  });
  const providerName = type === "HUBSPOT" ? "HubSpot" : type === "ZOHO" ? "Zoho" : "Google";
  const signInError =
    signIn.error instanceof ApiError
      ? signIn.error.fieldErrors.map((e) => e.message).join(". ") || null
      : null;
  const fieldErrors = save.error instanceof ApiError ? save.error.fieldErrors : [];
  const err = (path: string) =>
    fieldErrors.find((e) => e.path === path || e.path.startsWith(`${path}.`))?.message;

  const available = (p: Provider) => oauth[p];
  const anyAvailable = providers.some(available);
  const emailSettings = type === "EMAIL_SMTP" && (
    <div className="grid gap-4 sm:grid-cols-2">
      <TextField
        label="Send summaries to"
        value={defaultTo}
        onChange={(e) => setDefaultTo(e.target.value)}
        error={err("config.defaultTo")}
        hint="Up to 5 addresses, separated by commas"
      />
      <TextField
        label="Sender name (optional)"
        value={fromName}
        onChange={(e) => setFromName(e.target.value)}
        placeholder="Front desk"
      />
    </div>
  );

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {save.error && !fieldErrors.length ? <Alert>{errorMessage(save.error)}</Alert> : null}
      {signIn.error ? <Alert>{signInError ?? errorMessage(signIn.error)}</Alert> : null}
      <TextField
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={err("name")}
        hint="Shown when choosing it for an agent"
      />

      {type === "GOOGLE_CALENDAR" ? (
        <TextField
          label="Calendar"
          value={calendarId}
          onChange={(e) => setCalendarId(e.target.value)}
          error={err("config.calendarId")}
          hint="“primary” for your main calendar, or a calendar id from its settings (…@group.calendar.google.com)"
        />
      ) : null}
      {type === "GOOGLE_SHEETS" ? (
        <>
          <TextField
            label="Spreadsheet link or id"
            value={sheet}
            onChange={(e) => setSheet(e.target.value)}
            error={err("config.spreadsheetId")}
            placeholder="https://docs.google.com/spreadsheets/d/…/edit"
          />
          <TextField
            label="Tab name"
            value={sheetName}
            onChange={(e) => setSheetName(e.target.value)}
            error={err("config.sheetName")}
          />
        </>
      ) : null}
      {signInFirst ? emailSettings : null}

      {signInFirst ? (
        <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-medium text-slate-950">Sign in to connect</p>
          <p className="-mt-2 text-xs text-slate-500">
            You'll go to {providers.map((p) => PROVIDER_NAME[p]).join(" or ")} to sign in and allow access,
            then come straight back here, connected. We never see your password.
          </p>
          <div className={providers.length > 1 ? "grid gap-2 sm:grid-cols-2" : "grid"}>
            {providers.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => signIn.mutate(p)}
                disabled={!available(p) || name.trim().length < 2 || signIn.isPending}
                aria-busy={signIn.isPending && signIn.variables === p ? true : undefined}
                className="flex h-11 items-center justify-center gap-2.5 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-950 shadow-xs transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ProviderMark provider={p} />
                {signIn.isPending && signIn.variables === p
                  ? "Opening…"
                  : `Continue with ${PROVIDER_NAME[p]}`}
              </button>
            ))}
          </div>
          {!anyAvailable || providers.some((p) => !available(p)) ? (
            <p className="text-xs text-amber-700">
              {providers
                .filter((p) => !available(p))
                .map((p) => PROVIDER_NAME[p])
                .join(" and ")}{" "}
              sign-in isn't switched on for this platform yet (the platform operator sets it up once).
              {anyAvailable ? "" : ` Until then, connect with ${MANUAL_LABEL[type]} below.`}
            </p>
          ) : null}
        </div>
      ) : null}

      {signInFirst ? (
        <button
          type="button"
          className="text-sm font-medium text-slate-600 underline-offset-4 hover:text-slate-950 hover:underline"
          aria-expanded={showManual}
          onClick={() => setShowManual((v) => !v)}
        >
          {showManual ? "Hide" : "Other ways to connect:"} {MANUAL_LABEL[type]}
        </button>
      ) : null}

      {showManual ? (
        <div className={signInFirst ? "space-y-4 border-t border-slate-200 pt-4" : "space-y-4"}>
          {isGoogle ? (
            <>
              <TextArea
                label={existing ? "Replace service account key (optional)" : "Service account key (JSON)"}
                rows={4}
                value={keyJson}
                onChange={(e) => setKeyJson(e.target.value)}
                error={err("credentials")}
                hint={
                  <>
                    Google Cloud console → IAM → Service accounts → Keys → Add key (JSON). Then share the{" "}
                    {type === "GOOGLE_CALENDAR"
                      ? "calendar (“Make changes to events”)"
                      : "spreadsheet (Editor)"}{" "}
                    with the service account&apos;s email address.
                  </>
                }
              />
              <input
                type="file"
                accept="application/json,.json"
                aria-label="Load the key file"
                className="text-sm"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f && f.size < 20_000) setKeyJson(await f.text());
                }}
              />
            </>
          ) : null}

          {type === "EMAIL_SMTP" && existing && typeof cfg.provider === "string" ? (
            <>
              <p className="text-sm text-slate-600">
                Sends as <strong>{String(cfg.account ?? cfg.from)}</strong>, signed in with{" "}
                {cfg.provider === "google" ? "Google" : "Microsoft"}. To use another mailbox, connect a new
                email integration and remove this one.
              </p>
              {emailSettings}
            </>
          ) : type === "EMAIL_SMTP" ? (
            <>
              <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
                <TextField
                  label="SMTP server"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  error={err("credentials.host")}
                  placeholder="smtp.office365.com"
                />
                <TextField
                  label="Port"
                  inputMode="numeric"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  error={err("credentials.port")}
                />
              </div>
              <Check
                label="Use TLS from the start (usually port 465)"
                checked={secure}
                onChange={setSecure}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="Username"
                  autoComplete="off"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
                <TextField
                  label={existing ? "Password (re-enter to change)" : "Password or app password"}
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  error={err("credentials.password")}
                />
              </div>
              <TextField
                label="Send from"
                type="email"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                error={err("config.from")}
              />
              {signInFirst ? null : emailSettings}
            </>
          ) : null}

          {type === "WEBHOOK" ? (
            <>
              <TextField
                label="Endpoint URL"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                error={err("config.url")}
                placeholder="https://example.com/hooks/calls"
              />
              <TextField
                label={existing ? "New signing secret (optional)" : "Signing secret (optional)"}
                type="password"
                autoComplete="new-password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                error={err("credentials.secret")}
                hint={
                  existing
                    ? "Leave empty to keep the current secret"
                    : "Leave empty to generate one (shown once)"
                }
              />
            </>
          ) : null}

          {type === "HUBSPOT" ? (
            <TextField
              label={existing ? "New private app token (optional)" : "Private app access token"}
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              error={err("credentials.token") ?? err("credentials")}
              placeholder="pat-na1-…"
              hint="HubSpot → Settings → Integrations → Private apps → Create. Scopes: crm.objects.contacts (read, write) and crm.schemas.contacts.read."
            />
          ) : null}
          {type === "ZOHO" ? (
            <>
              <SelectField
                label="Data center"
                value={dataCenter}
                onChange={(e) => setDataCenter(e.target.value)}
                error={err("credentials.accountsServer")}
              >
                {ZOHO_DATA_CENTERS.map((d) => (
                  <option key={d.server} value={d.server}>
                    {d.label}
                  </option>
                ))}
              </SelectField>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="Client ID"
                  autoComplete="off"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  error={err("credentials.clientId")}
                />
                <TextField
                  label="Client secret"
                  type="password"
                  autoComplete="off"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  error={err("credentials.clientSecret")}
                />
              </div>
              <TextField
                label={existing ? "New refresh token (optional)" : "Refresh token"}
                type="password"
                autoComplete="off"
                value={refreshToken}
                onChange={(e) => setRefreshToken(e.target.value)}
                error={err("credentials.refreshToken") ?? err("credentials")}
                hint="Zoho API console → Self Client. Scopes: ZohoCRM.modules.leads.ALL,ZohoCRM.settings.fields.READ; exchange the grant code for a refresh token."
              />
            </>
          ) : null}
          {isCrm(type) ? (
            <p className="text-xs text-slate-500">
              After connecting, choose which answers go to which {providerName} fields under “Field mapping”.
            </p>
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="submit" loading={save.isPending} variant={signInFirst ? "secondary" : "primary"}>
              {existing
                ? "Save changes"
                : isGoogle
                  ? "Connect with key"
                  : type === "HUBSPOT"
                    ? "Connect with token"
                    : type === "ZOHO"
                      ? "Connect Self Client"
                      : type === "EMAIL_SMTP"
                        ? "Connect mail server"
                        : "Connect"}
            </Button>
          </div>
        </div>
      ) : null}
    </form>
  );
}

/** Brand marks for the sign-in buttons (drawn inline: no external images under the CSP) */
function ProviderMark({ provider }: { provider: Provider }) {
  if (provider === "google")
    return (
      <svg viewBox="0 0 48 48" className="size-[18px]" aria-hidden>
        <path
          fill="#EA4335"
          d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
        />
        <path
          fill="#4285F4"
          d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
        />
        <path
          fill="#FBBC05"
          d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
        />
        <path
          fill="#34A853"
          d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
        />
      </svg>
    );
  if (provider === "microsoft")
    return (
      <svg viewBox="0 0 21 21" className="size-[16px]" aria-hidden>
        <rect x="1" y="1" width="9" height="9" fill="#F25022" />
        <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
        <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
        <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
      </svg>
    );
  return (
    <span
      className="grid size-[18px] place-items-center rounded text-[10px] font-bold text-white"
      style={{ background: provider === "hubspot" ? "#FF7A59" : "#E42527" }}
      aria-hidden
    >
      {provider === "hubspot" ? "H" : "Z"}
    </span>
  );
}
