import type { Integration } from "@/lib/types";

export type ConnectableType =
  "GOOGLE_CALENDAR" | "GOOGLE_SHEETS" | "EMAIL_SMTP" | "WEBHOOK" | "HUBSPOT" | "ZOHO";

export const isCrm = (type: string): type is "HUBSPOT" | "ZOHO" => type === "HUBSPOT" || type === "ZOHO";

/** Zoho data centers, by the accounts server a Self Client token was made in */
export const ZOHO_DATA_CENTERS: { server: string; label: string }[] = [
  { server: "https://accounts.zoho.in", label: "India (zoho.in)" },
  { server: "https://accounts.zoho.com", label: "United States (zoho.com)" },
  { server: "https://accounts.zoho.eu", label: "Europe (zoho.eu)" },
  { server: "https://accounts.zoho.sa", label: "Saudi Arabia (zoho.sa)" },
  { server: "https://accounts.zoho.com.au", label: "Australia (zoho.com.au)" },
  { server: "https://accounts.zoho.jp", label: "Japan (zoho.jp)" },
  { server: "https://accounts.zohocloud.ca", label: "Canada (zohocloud.ca)" },
];

export const CATALOG: {
  type: string;
  label: string;
  description: string;
  available: boolean;
  /** Set up on its own page instead of the connect dialog (path inside the tenant) */
  page?: string;
}[] = [
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
    label: "Email",
    description:
      "Send call summaries and missed-transfer alerts from your Gmail, Outlook / Microsoft 365 or any mail server.",
    available: true,
  },
  {
    type: "WEBHOOK",
    label: "Webhook",
    description: "Post call details to your own system, signed so you can trust them.",
    available: true,
  },
  {
    type: "HUBSPOT",
    label: "HubSpot",
    description: "Send every caller to HubSpot as a contact, with their answers in your own fields.",
    available: true,
  },
  {
    type: "ZOHO",
    label: "Zoho CRM",
    description: "Send every caller to Zoho CRM as a lead, in your own data center.",
    available: true,
  },
  {
    type: "CALCOM",
    label: "Cal.com",
    description: "Book through your Cal.com event types.",
    available: false,
  },
  {
    type: "WHATSAPP",
    label: "WhatsApp",
    description: "Connect your WhatsApp Business number: the agent answers chats and voice notes.",
    available: true,
    page: "settings/whatsapp",
  },
];

export const INTEGRATION_LABEL: Record<string, string> = Object.fromEntries(
  CATALOG.map((c) => [c.type, c.label]),
);

/** One line saying what the integration points at (never secrets: those are not sent to the browser) */
export function describeConfig(i: Pick<Integration, "type" | "config">): string {
  const c = i.config as Record<string, string | number | string[] | undefined>;
  switch (i.type) {
    case "GOOGLE_CALENDAR":
      return `Calendar: ${c.calendarId ?? "primary"}${c.auth === "oauth" ? " · signed in with Google" : c.account ? ` · shared with ${c.account}` : ""}`;
    case "GOOGLE_SHEETS":
      return `Sheet "${c.sheetName ?? "Sheet1"}" in ${String(c.spreadsheetId ?? "").slice(0, 12)}…${c.auth === "oauth" ? " · signed in with Google" : c.account ? ` · shared with ${c.account}` : ""}`;
    case "EMAIL_SMTP": {
      const to = Array.isArray(c.defaultTo) ? c.defaultTo.join(", ") : "";
      const via =
        c.provider === "google"
          ? "Gmail"
          : c.provider === "microsoft"
            ? "Outlook"
            : `${c.host ?? ""}:${c.port ?? ""}`;
      return `${c.from ?? ""} via ${via} → ${to}`;
    }
    case "WEBHOOK":
      return String(c.url ?? "");
    case "HUBSPOT":
    case "ZOHO": {
      const center = ZOHO_DATA_CENTERS.find((d) => d.server === c.dataCenter)?.label;
      const mapped = Object.keys((c.mapping as unknown as Record<string, string> | undefined) ?? {}).length;
      const how = c.auth === "oauth" ? "Signed in" : i.type === "HUBSPOT" ? "Private app" : "Self Client";
      return [
        how,
        center,
        (c.syncLeads as unknown) === false ? "lead sync off" : "leads sync after each call",
        `${mapped} ${mapped === 1 ? "field" : "fields"} mapped`,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    default:
      return "";
  }
}

/** Accept a full Google Sheets URL or just its id */
export function spreadsheetIdFrom(input: string): string {
  return /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(input)?.[1] ?? input.trim();
}
