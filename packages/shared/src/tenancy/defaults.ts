import { z } from "zod";

/** Lead pipeline created for every new tenant; tenants can rename/reorder/add afterwards */
export const DEFAULT_LEAD_STATUSES = [
  { key: "new", label: "New", color: "#2563eb", sortOrder: 0, isDefault: true, isTerminal: false },
  {
    key: "contacted",
    label: "Contacted",
    color: "#0891b2",
    sortOrder: 1,
    isDefault: false,
    isTerminal: false,
  },
  {
    key: "qualified",
    label: "Qualified",
    color: "#16a34a",
    sortOrder: 2,
    isDefault: false,
    isTerminal: false,
  },
  {
    key: "follow_up",
    label: "Follow-up",
    color: "#d97706",
    sortOrder: 3,
    isDefault: false,
    isTerminal: false,
  },
  { key: "won", label: "Won", color: "#15803d", sortOrder: 4, isDefault: false, isTerminal: true },
  { key: "lost", label: "Lost", color: "#64748b", sortOrder: 5, isDefault: false, isTerminal: true },
] as const;

/** Plan limits stored in tenants.usage_limits */
export const TenantLimits = z.object({
  maxAgents: z.number().int().min(0).default(3),
  maxCallsPerDay: z.number().int().min(0).default(200),
  maxCallMinutesPerMonth: z.number().int().min(0).default(1000),
  maxDocuments: z.number().int().min(0).default(100),
  maxStorageMb: z.number().int().min(0).default(500),
  maxDocumentSizeMb: z.number().int().min(1).default(25),
  maxLlmTokensPerDay: z.number().int().min(0).default(2_000_000),
});
export type TenantLimits = z.infer<typeof TenantLimits>;

export const TenantSlug = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase letters, numbers and single hyphens");

export const E164 = z.string().regex(/^\+[1-9]\d{6,14}$/, "phone number in E.164 format, e.g. +919876543210");
