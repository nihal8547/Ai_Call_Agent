/** BullMQ queue names — the single list used by producers (API) and consumers (worker) */
export const QUEUES = {
  system: "system",
  ingestion: "ingestion",
  exports: "exports",
  crm: "crm",
  notifications: "notifications",
  analytics: "analytics",
  webhooks: "webhooks",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Payload of an `ingestion` job */
export type IngestionJob = { tenantId: string; documentId: string };
