/** BullMQ queue names — the single list used by producers (API) and consumers (worker) */
export const QUEUES = {
  system: "system",
  ingestion: "ingestion",
  exports: "exports",
  crm: "crm",
  notifications: "notifications",
  analytics: "analytics",
  webhooks: "webhooks",
  /** WhatsApp messages to customers (staff replies now; agent replies from W2) */
  whatsapp: "whatsapp",
  /** The platform's own emails (invitations, password resets); not tied to one business */
  mail: "mail",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Payload of an `ingestion` job */
export type IngestionJob = { tenantId: string; documentId: string };

/** Every tenant job says what it does in words, for the failed-jobs list */
type TenantJob = { tenantId: string; label: string };

/**
 * A non-blocking tool the agent ran during a call (`webhooks` for webhooks, `notifications` for
 * email, `crm` for spreadsheets and CRMs): the call's reply never waits for it.
 */
export type ToolJob = TenantJob & {
  kind: "tool";
  callId: string;
  agentId: string;
  agentVersionId: string;
  callerNumber: string;
  timezone: string;
  /** The business's calling code; missing on jobs queued before it was added */
  callingCode?: string;
  call: {
    tool: string;
    input: Record<string, unknown>;
    stepId: string;
    background: boolean;
    idempotencyKey: string;
  };
};

/** An email to staff through the tenant's SMTP integration (`notifications`) */
export type EmailJob = TenantJob & {
  kind: "email";
  callId?: string;
  to: string[];
  subject: string;
  text: string;
  idempotencyKey: string;
};

/** Push a lead to one CRM integration (`crm`); the job reads the lead as it is when it runs */
export type LeadSyncJob = TenantJob & { kind: "lead_sync"; leadId: string; integrationId: string };

/** An email from the platform itself, sent through SMTP_URL (`mail`) */
export type PlatformMailJob = {
  kind: "platform_mail";
  purpose: "invitation" | "password_reset";
  to: string;
  subject: string;
  text: string;
  html: string;
};

/** Recompute analytics roll-ups (`analytics`) */
export type AnalyticsJob =
  | { kind: "rollup"; tenantId: string; from: string; to: string }
  /** Periodic: every tenant with calls in the last hours */
  | { kind: "sweep"; hours: number };

/** Send one queued WhatsApp message (`whatsapp`); the job reads the message row when it runs */
export type WhatsAppSendJob = TenantJob & { kind: "whatsapp_send"; messageId: string };

export type QueueJob = ToolJob | EmailJob | LeadSyncJob | WhatsAppSendJob;

/** Where a background tool's job goes: webhooks, messages to people, or records (leads, sheets, CRMs) */
export function queueForTool(tool: string): "webhooks" | "notifications" | "crm" {
  if (tool.startsWith("webhook.")) return QUEUES.webhooks;
  if (/^(email|sms|whatsapp)\./.test(tool)) return QUEUES.notifications;
  return QUEUES.crm;
}

/**
 * Retry policy per queue: attempts and the first backoff delay (doubled each time).
 * Webhooks carry an idempotency key, so receivers can drop repeats; CRM upserts are idempotent.
 */
export const QUEUE_RETRY: Record<
  "webhooks" | "notifications" | "crm" | "analytics" | "whatsapp",
  { attempts: number; delayMs: number }
> = {
  webhooks: { attempts: 6, delayMs: 5_000 },
  notifications: { attempts: 4, delayMs: 10_000 },
  crm: { attempts: 6, delayMs: 10_000 },
  analytics: { attempts: 3, delayMs: 5_000 },
  // Meta has no idempotency key: only failures before Meta accepted the message are retried
  whatsapp: { attempts: 4, delayMs: 3_000 },
};
