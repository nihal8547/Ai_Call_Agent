import { verifySmtp, type SmtpCredentials } from "./email";
import { ToolError } from "./errors";
import type { GoogleCredentials, GoogleDeps } from "./google/auth";
import { checkCalendar } from "./google/calendar";
import { checkSheet } from "./google/sheets";
import { postWebhook } from "./webhook";

export type ConnectionTestDeps = {
  fetch?: typeof fetch;
  googleOAuth?: { clientId: string; clientSecret: string };
  allowPrivateNetwork?: boolean;
  timeoutMs?: number;
};

/**
 * Prove an integration works without side effects where possible:
 * open the calendar or sheet, log in to the mail server, send a signed `ping` to the webhook.
 * Returns a human description on success; throws ToolError otherwise.
 */
export async function testConnection(
  type: string,
  config: Record<string, unknown>,
  credentials: Record<string, unknown>,
  deps: ConnectionTestDeps = {},
): Promise<string> {
  const timeoutMs = deps.timeoutMs ?? 8000;
  const google: GoogleDeps = {
    fetch: deps.fetch ?? fetch,
    timeoutMs,
    ...(deps.googleOAuth ? { oauthClient: deps.googleOAuth } : {}),
  };
  const allowPrivateNetwork = deps.allowPrivateNetwork ?? false;
  switch (type) {
    case "GOOGLE_CALENDAR": {
      const c = await checkCalendar(
        { credentials: credentials as GoogleCredentials, calendarId: String(config.calendarId ?? "primary") },
        google,
      );
      return `Connected to calendar "${c.summary}"`;
    }
    case "GOOGLE_SHEETS": {
      const s = await checkSheet(
        {
          credentials: credentials as GoogleCredentials,
          spreadsheetId: String(config.spreadsheetId),
          sheetName: String(config.sheetName ?? "Sheet1"),
        },
        google,
      );
      return `Connected to spreadsheet "${s.title}"`;
    }
    case "EMAIL_SMTP":
      await verifySmtp(credentials as unknown as SmtpCredentials, { allowPrivateNetwork, timeoutMs });
      return "Logged in to the mail server";
    case "WEBHOOK": {
      const r = await postWebhook(
        String(config.url),
        String(credentials.secret),
        { event: "ping", occurredAt: new Date().toISOString() },
        { allowPrivateNetwork, timeoutMs, idempotencyKey: `ping-${Date.now()}` },
      );
      return `Your endpoint answered ${r.status}`;
    }
    default:
      throw new ToolError("config", "This integration type can't be tested yet");
  }
}
