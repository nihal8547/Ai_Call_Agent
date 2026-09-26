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
export type OAuthAvailability = { google: boolean; hubspot: boolean; zoho: boolean };

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
  const signIn = isGoogle
    ? oauth.google
    : type === "HUBSPOT"
      ? oauth.hubspot
      : type === "ZOHO"
        ? oauth.zoho
        : false;
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
  const google = useMutation({
    mutationFn: () =>
      api<{ url: string }>(
        isGoogle
          ? `/integrations/oauth/google/start?${new URLSearchParams({ type, name, config: JSON.stringify(config()) })}`
          : `/integrations/oauth/${type === "HUBSPOT" ? "hubspot" : "zoho"}/start?${new URLSearchParams({ name })}`,
      ),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  const providerName = type === "HUBSPOT" ? "HubSpot" : type === "ZOHO" ? "Zoho" : "Google";
  const fieldErrors = save.error instanceof ApiError ? save.error.fieldErrors : [];
  const err = (path: string) =>
    fieldErrors.find((e) => e.path === path || e.path.startsWith(`${path}.`))?.message;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {save.error && !fieldErrors.length ? <Alert>{errorMessage(save.error)}</Alert> : null}
      {google.error ? <Alert>{errorMessage(google.error)}</Alert> : null}
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
          hint="“primary” for the main calendar, or a calendar id from its settings (…@group.calendar.google.com)"
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

      {isGoogle ? (
        <div className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
          {signIn && !existing ? (
            <>
              <Button
                type="button"
                className="w-full"
                loading={google.isPending}
                onClick={() => google.mutate()}
                disabled={name.trim().length < 2}
              >
                Connect with Google
              </Button>
              <p className="text-center text-xs text-slate-500">or use a service account key</p>
            </>
          ) : null}
          <TextArea
            label={existing ? "Replace service account key (optional)" : "Service account key (JSON)"}
            rows={4}
            value={keyJson}
            onChange={(e) => setKeyJson(e.target.value)}
            error={err("credentials")}
            hint={
              <>
                Google Cloud console → IAM → Service accounts → Keys → Add key (JSON). Then share the{" "}
                {type === "GOOGLE_CALENDAR" ? "calendar (“Make changes to events”)" : "spreadsheet (Editor)"}{" "}
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
        </div>
      ) : null}

      {type === "EMAIL_SMTP" ? (
        <>
          <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
            <TextField
              label="SMTP server"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              error={err("credentials.host")}
              placeholder="smtp.gmail.com"
            />
            <TextField
              label="Port"
              inputMode="numeric"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              error={err("credentials.port")}
            />
          </div>
          <Check label="Use TLS from the start (usually port 465)" checked={secure} onChange={setSecure} />
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
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Send from"
              type="email"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              error={err("config.from")}
            />
            <TextField label="Sender name" value={fromName} onChange={(e) => setFromName(e.target.value)} />
          </div>
          <TextField
            label="Send summaries to"
            value={defaultTo}
            onChange={(e) => setDefaultTo(e.target.value)}
            error={err("config.defaultTo")}
            hint="Up to 5 addresses, separated by commas"
          />
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
              existing ? "Leave empty to keep the current secret" : "Leave empty to generate one (shown once)"
            }
          />
        </>
      ) : null}

      {isCrm(type) ? (
        <div className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
          {signIn && !existing ? (
            <>
              <Button
                type="button"
                className="w-full"
                loading={google.isPending}
                onClick={() => google.mutate()}
                disabled={name.trim().length < 2}
              >
                Connect with {providerName}
              </Button>
              <p className="text-center text-xs text-slate-500">
                or use {type === "HUBSPOT" ? "a private app token" : "a Self Client"}
              </p>
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
          ) : (
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
          )}
          <p className="text-xs text-slate-500">
            After connecting, choose which answers go to which {providerName} fields under “Field mapping”.
          </p>
        </div>
      ) : null}

      <div className="flex justify-end gap-2 pt-2">
        <Button
          type="submit"
          loading={save.isPending}
          variant={(isGoogle || isCrm(type)) && signIn && !existing ? "secondary" : "primary"}
        >
          {existing
            ? "Save changes"
            : isGoogle
              ? "Connect with key"
              : type === "HUBSPOT"
                ? "Connect with token"
                : type === "ZOHO"
                  ? "Connect Self Client"
                  : "Connect"}
        </Button>
      </div>
    </form>
  );
}
