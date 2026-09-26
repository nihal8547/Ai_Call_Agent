import { z } from "zod";
import { CursorPageQuery } from "../common/pagination";
import { E164 } from "../tenancy/defaults";

const DateTime = z.coerce.date();

export const CALL_STATUSES = [
  "RINGING",
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
  "NO_ANSWER",
  "BUSY",
  "CANCELED",
] as const;
export const CALL_OUTCOMES = [
  "LEAD_CAPTURED",
  "APPOINTMENT_BOOKED",
  "ENQUIRY_ANSWERED",
  "HUMAN_HANDOFF",
  "FOLLOW_UP_REQUIRED",
  "ABANDONED",
  "NONE",
] as const;
export const QUALIFICATION_STATUSES = ["NOT_STARTED", "PARTIAL", "QUALIFIED", "DISQUALIFIED"] as const;

export const ListCallsQuery = CursorPageQuery.extend({
  agentId: z.uuid().optional(),
  status: z.enum(CALL_STATUSES).optional(),
  outcome: z.enum(CALL_OUTCOMES).optional(),
  qualification: z.enum(QUALIFICATION_STATUSES).optional(),
  from: DateTime.optional(),
  to: DateTime.optional(),
});

export const ListLeadsQuery = CursorPageQuery.extend({
  statusId: z.uuid().optional(),
  agentId: z.uuid().optional(),
  /** Search by name, phone or email */
  q: z.string().trim().min(2).max(100).optional(),
});

export const UpdateLeadBody = z
  .object({
    statusId: z.uuid(),
    customerName: z.string().trim().min(1).max(160).nullable(),
    email: z.email().max(254).nullable(),
    notes: z.string().max(5000).nullable(),
    followUpAt: DateTime.nullable(),
    assigneeId: z.uuid().nullable(),
    /** Qualification answers; each key is validated against the agent's field definition */
    data: z.record(z.string().max(40), z.unknown()),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Nothing to update");

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Colour as #RRGGBB");

export const CreateLeadStatusBody = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, "lowercase_snake_case"),
  label: z.string().trim().min(1).max(80),
  color: HexColor.default("#64748b"),
  sortOrder: z.number().int().min(0).max(1000).default(100),
  isDefault: z.boolean().default(false),
  isTerminal: z.boolean().default(false),
});
export const UpdateLeadStatusBody = CreateLeadStatusBody.omit({ key: true })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Nothing to update");

export const CreatePhoneNumberBody = z.object({
  e164: E164,
  friendlyName: z.string().trim().max(80).optional(),
  agentId: z.uuid().nullable().optional(),
  providerSid: z.string().max(64).optional(),
});
export const UpdatePhoneNumberBody = z
  .object({
    friendlyName: z.string().trim().max(80).nullable(),
    agentId: z.uuid().nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Nothing to update");
