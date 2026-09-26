import { z } from "zod";
import { CursorPageQuery } from "../common/pagination";
import { ToolName } from "../agent/tools";

// ── Integrations ─────────────────────────────────────────────────────────────
// Credentials are write-only: they are encrypted with the tenant's key and never returned.

const Name = z.string().trim().min(2).max(80);

export const GoogleCalendarConfig = z.object({
  /** "primary" or a calendar id such as abc@group.calendar.google.com */
  calendarId: z.string().trim().min(1).max(254).default("primary"),
});
export const GoogleSheetsConfig = z.object({
  spreadsheetId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{20,100}$/, "Paste the id from the sheet's URL (between /d/ and /edit)"),
  sheetName: z.string().trim().min(1).max(100).default("Sheet1"),
});
export const SmtpConfig = z.object({
  from: z.email(),
  fromName: z.string().trim().max(80).optional(),
  /** Where summaries go when a tool does not name a recipient */
  defaultTo: z.array(z.email()).min(1).max(5),
});
export const WebhookConfig = z.object({
  url: z.url({ protocol: /^https?$/ }).max(2000),
});

/** A Google service account key file, pasted as JSON */
export const ServiceAccountJson = z
  .string()
  .max(10_000)
  .transform((s, ctx) => {
    try {
      const j = JSON.parse(s) as { client_email?: unknown; private_key?: unknown; type?: unknown };
      if (
        typeof j.client_email === "string" &&
        typeof j.private_key === "string" &&
        j.private_key.includes("PRIVATE KEY")
      )
        return { clientEmail: j.client_email, privateKey: j.private_key };
    } catch {
      // fall through
    }
    ctx.addIssue({ code: "custom", message: "Paste the service account's JSON key file" });
    return z.NEVER;
  });

export const GoogleCredentialsInput = z.object({
  kind: z.literal("service_account"),
  json: ServiceAccountJson,
});
export const SmtpCredentials = z.object({
  host: z
    .string()
    .trim()
    .min(3)
    .max(253)
    .regex(/^[A-Za-z0-9.-]+$/, "Host name only, e.g. smtp.gmail.com"),
  port: z.number().int().min(1).max(65535).default(587),
  /** true = TLS from the start (port 465); false = STARTTLS */
  secure: z.boolean().default(false),
  username: z.string().max(254).optional(),
  password: z.string().max(500).optional(),
});
export const WebhookCredentials = z.object({
  /** Signing secret; generated when omitted */
  secret: z.string().min(16).max(200).optional(),
});

export const CreateIntegrationBody = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("GOOGLE_CALENDAR"),
    name: Name,
    config: GoogleCalendarConfig,
    credentials: GoogleCredentialsInput,
  }),
  z.object({
    type: z.literal("GOOGLE_SHEETS"),
    name: Name,
    config: GoogleSheetsConfig,
    credentials: GoogleCredentialsInput,
  }),
  z.object({ type: z.literal("EMAIL_SMTP"), name: Name, config: SmtpConfig, credentials: SmtpCredentials }),
  z.object({
    type: z.literal("WEBHOOK"),
    name: Name,
    config: WebhookConfig,
    credentials: WebhookCredentials.default({}),
  }),
]);
export type CreateIntegrationBody = z.infer<typeof CreateIntegrationBody>;

/** Types that can be connected in this release, and how */
export const CONNECTABLE_INTEGRATIONS = [
  "GOOGLE_CALENDAR",
  "GOOGLE_SHEETS",
  "EMAIL_SMTP",
  "WEBHOOK",
] as const;
export type ConnectableIntegration = (typeof CONNECTABLE_INTEGRATIONS)[number];

export const INTEGRATION_CONFIG: Record<ConnectableIntegration, z.ZodType> = {
  GOOGLE_CALENDAR: GoogleCalendarConfig,
  GOOGLE_SHEETS: GoogleSheetsConfig,
  EMAIL_SMTP: SmtpConfig,
  WEBHOOK: WebhookConfig,
};
export const INTEGRATION_CREDENTIALS: Record<ConnectableIntegration, z.ZodType> = {
  GOOGLE_CALENDAR: GoogleCredentialsInput,
  GOOGLE_SHEETS: GoogleCredentialsInput,
  EMAIL_SMTP: SmtpCredentials,
  WEBHOOK: WebhookCredentials,
};

/** Validated per type by the API */
export const UpdateIntegrationBody = z
  .object({
    name: Name,
    config: z.record(z.string(), z.unknown()),
    /** Replaces the stored credentials entirely */
    credentials: z.record(z.string(), z.unknown()),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Nothing to update");

export const GoogleOAuthStartQuery = z.object({
  type: z.enum(["GOOGLE_CALENDAR", "GOOGLE_SHEETS"]),
  name: Name,
  /** Calendar id or spreadsheet settings, as JSON */
  config: z.string().max(2000).optional(),
});

// ── Tool bindings ────────────────────────────────────────────────────────────
export const SaveToolBindingsBody = z.object({
  bindings: z.array(z.object({ toolName: ToolName, integrationId: z.uuid().nullable() })).max(20),
});

// ── Appointments ─────────────────────────────────────────────────────────────
export const APPOINTMENT_STATUSES = ["UPCOMING", "COMPLETED", "CANCELLED", "RESCHEDULED", "NO_SHOW"] as const;

export const ListAppointmentsQuery = CursorPageQuery.extend({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  status: z.enum(APPOINTMENT_STATUSES).optional(),
  agentId: z.uuid().optional(),
}).refine((q) => !q.from || !q.to || new Date(q.from) < new Date(q.to), {
  message: "from must be before to",
  path: ["to"],
});

export const UpdateAppointmentBody = z
  .object({
    /** Move to a new date and time in the business time zone */
    reschedule: z.object({ date: z.iso.date(), time: z.string().regex(/^\d{2}:\d{2}$/, "HH:MM") }),
    status: z.enum(["UPCOMING", "COMPLETED", "CANCELLED", "NO_SHOW"]),
    notes: z.string().trim().max(2000).nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Nothing to update")
  .refine((b) => !(b.reschedule && b.status), {
    message: "Reschedule or change the status, not both",
    path: ["status"],
  });
