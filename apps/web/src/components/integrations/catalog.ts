import type { Integration } from "@/lib/types";

export type ConnectableType = "GOOGLE_CALENDAR" | "GOOGLE_SHEETS" | "EMAIL_SMTP" | "WEBHOOK";

export const CATALOG: { type: string; label: string; description: string; available: boolean }[] = [
  {
    type: "GOOGLE_CALENDAR",
    label: "Google Calendar",
    description: "Offer free times and book appointments straight into your calendar.",
    available: true,
  },
  {
    type: "GOOGLE_SHEETS",
    label: "Google Sheets",
    description: "Add a row for every call or lead to a spreadsheet.",
    available: true,
  },
  {
    type: "EMAIL_SMTP",
    label: "Email (SMTP)",
    description: "Send call summaries and missed-transfer alerts from your own mail account.",
    available: true,
  },
  {
    type: "WEBHOOK",
    label: "Webhook",
    description: "Post call details to your own system, signed so you can trust them.",
    available: true,
  },
  { type: "HUBSPOT", label: "HubSpot", description: "Create and update CRM leads.", available: false },
  { type: "ZOHO", label: "Zoho CRM", description: "Create and update CRM leads.", available: false },
  {
    type: "CALCOM",
    label: "Cal.com",
    description: "Book through your Cal.com event types.",
    available: false,
  },
  { type: "WHATSAPP", label: "WhatsApp", description: "Send confirmations on WhatsApp.", available: false },
];

export const INTEGRATION_LABEL: Record<string, string> = Object.fromEntries(
  CATALOG.map((c) => [c.type, c.label]),
);

/** One line saying what the integration points at (never secrets: those are not sent to the browser) */
export function describeConfig(i: Pick<Integration, "type" | "config">): string {
  const c = i.config as Record<string, string | number | string[] | undefined>;
  switch (i.type) {
    case "GOOGLE_CALENDAR":
      return `Calendar: ${c.calendarId ?? "primary"}${c.account ? ` · shared with ${c.account}` : ""}`;
    case "GOOGLE_SHEETS":
      return `Sheet "${c.sheetName ?? "Sheet1"}" in ${String(c.spreadsheetId ?? "").slice(0, 12)}…${c.account ? ` · shared with ${c.account}` : ""}`;
    case "EMAIL_SMTP":
      return `${c.from ?? ""} via ${c.host ?? ""}:${c.port ?? ""} → ${Array.isArray(c.defaultTo) ? c.defaultTo.join(", ") : ""}`;
    case "WEBHOOK":
      return String(c.url ?? "");
    default:
      return "";
  }
}

/** Accept a full Google Sheets URL or just its id */
export function spreadsheetIdFrom(input: string): string {
  return /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(input)?.[1] ?? input.trim();
}
