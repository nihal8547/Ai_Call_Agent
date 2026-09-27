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
    /** Simultaneous calls allowed (null = no limit) */
    maxConcurrentCalls: z.number().int().min(1).max(500).nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Nothing to update");

// ── Agents ──────────────────────────────────────────────────────────────────
export const CreateAgentBody = z.object({
  name: z.string().trim().min(2).max(80),
  templateKey: z.string().min(1).max(60),
  description: z.string().trim().max(500).optional(),
  /** Name the agent introduces itself with; defaults to the template's */
  agentName: z.string().trim().min(1).max(60).optional(),
});

export const UpdateAgentBody = z
  .object({ name: z.string().trim().min(2).max(80), description: z.string().trim().max(500).nullable() })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Nothing to update");

/** The config is validated with AgentConfig on the server; the envelope only carries it */
export const SaveDraftBody = z.object({
  config: z.record(z.string(), z.unknown()),
  changeNote: z.string().trim().max(500).optional(),
});

export const SetAgentStatusBody = z.object({ status: z.enum(["ACTIVE", "INACTIVE"]) });

export const AnalyticsSummaryQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
/** Whole days in the business's time zone, both inclusive (YYYY-MM-DD), at most a year */
export const AnalyticsRangeQuery = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    agentId: z.uuid().optional(),
  })
  .refine((q) => q.from <= q.to, { message: "from must not be after to", path: ["to"] })
  .refine((q) => (dayMs(q.to) - dayMs(q.from)) / 86_400_000 < 366, {
    message: "At most a year at a time",
    path: ["from"],
  });
export const UsageSummaryQuery = AnalyticsRangeQuery;

// ── Test console ────────────────────────────────────────────────────────────
export const StartTestSessionBody = z.object({
  /** Which version to talk to; defaults to the draft, else the published version */
  versionId: z.uuid().optional(),
  /** Pretend the call happens at this moment (to try working hours) */
  simulatedAt: z.coerce.date().optional(),
  /** Make every tool call fail, to rehearse outages */
  failTools: z.boolean().default(false),
  /** "chat": reply as the agent writes on WhatsApp; "voice" (default): as it speaks on calls */
  channel: z.enum(["voice", "chat"]).default("voice"),
});
export const TestMessageBody = z.object({ text: z.string().max(1000) });

// ── Knowledge ───────────────────────────────────────────────────────────────
export const DOCUMENT_STATUSES = [
  "UPLOADING",
  "PROCESSING",
  "EXTRACTING",
  "EMBEDDING",
  "READY",
  "FAILED",
] as const;

export const CollectionSettings = z.object({
  targetTokens: z.number().int().min(100).max(1200).optional(),
  overlapTokens: z.number().int().min(0).max(300).optional(),
});
export const CreateCollectionBody = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional(),
  settings: CollectionSettings.default({}),
});
export const UpdateCollectionBody = CreateCollectionBody.partial().refine(
  (b) => Object.keys(b).length > 0,
  "Nothing to update",
);

export const ListDocumentsQuery = CursorPageQuery.extend({
  collectionId: z.uuid().optional(),
  status: z.enum(DOCUMENT_STATUSES).optional(),
  q: z.string().trim().min(1).max(100).optional(),
});

/** Multipart form fields sent with an upload */
export const UploadDocumentFields = z.object({
  collectionId: z.uuid(),
  title: z.string().trim().min(1).max(200).optional(),
});

export const UpdateDocumentBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    enabled: z.boolean(),
    /** Restrict the document to these agents; [] = every agent using its collection */
    agentIds: z.array(z.uuid()).max(50),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Nothing to update");

export const KnowledgeSearchBody = z.object({
  query: z.string().trim().min(2).max(500),
  collectionIds: z.array(z.uuid()).max(20).optional(),
  agentId: z.uuid().optional(),
  topK: z.number().int().min(1).max(20).default(5),
});

// ── Knowledge gaps ──────────────────────────────────────────────────────────
export const KnowledgeGapsQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  agentId: z.uuid().optional(),
});

/** Answer an unanswered question: becomes a small document in the chosen collection */
export const CreateFaqBody = z.object({
  collectionId: z.uuid(),
  question: z.string().trim().min(3).max(300),
  answer: z.string().trim().min(2).max(2000),
  /** The gap this answers, so it disappears from the report */
  gapKey: z.string().max(300).optional(),
});

export const FAILED_JOB_STATUSES = ["FAILED", "RETRIED", "DISMISSED"] as const;
export const FailedJobsQuery = z.object({
  status: z.enum(FAILED_JOB_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ── Existing numbers: forwarding and SIP ─────────────────────────────────────
export const CARRIER_KEYS = ["ooredoo", "vodafone_qa", "other"] as const;
export const FORWARDING_MODE_KEYS = ["NO_ANSWER_BUSY_UNREACHABLE", "ALL"] as const;
/** A phone number as typed by staff: E.164, or local digits in the business's country */
const TypedNumber = z.string().trim().min(6).max(24);

/** Point the business's existing line (Ooredoo, Vodafone, …) at one of its Twilio numbers */
export const ConnectForwardingBody = z.object({
  businessNumber: TypedNumber,
  carrier: z.enum(CARRIER_KEYS),
  mode: z.enum(FORWARDING_MODE_KEYS).default("NO_ANSWER_BUSY_UNREACHABLE"),
});
/** Open a 10-minute window for a test call; optionally only from the phone staff will call from */
export const VerifyNumberBody = z.object({ from: TypedNumber.optional() });

export const TWILIO_NUMBER_TYPES = ["local", "mobile", "toll_free"] as const;
export const SearchTwilioNumbersQuery = z.object({
  country: z.string().regex(/^[A-Z]{2}$/, "Two-letter country code"),
  type: z.enum(TWILIO_NUMBER_TYPES).default("local"),
  contains: z
    .string()
    .regex(/^[0-9*]{1,10}$/)
    .optional(),
});
export const BuyTwilioNumberBody = z.object({
  phoneNumber: E164,
  agentId: z.uuid().nullable().optional(),
  friendlyName: z.string().trim().max(80).optional(),
});
/** A number already on the platform's Twilio account (bought in the Twilio console) */
export const ImportTwilioNumberBody = z.object({
  sid: z.string().regex(/^PN[0-9a-f]{32}$/i, "Twilio number SID (PN…)"),
  agentId: z.uuid().nullable().optional(),
  friendlyName: z.string().trim().max(80).optional(),
});

export const SIP_CARRIER_KEYS = ["ooredoo", "vodafone_qa", "pbx", "other"] as const;
export const CreateSipTrunkBody = z.object({
  name: z.string().trim().min(2).max(80),
  carrier: z.enum(SIP_CARRIER_KEYS),
  /** The carrier's or PBX's public signalling addresses (IPv4 or CIDR, /16 or narrower) */
  allowedIps: z.array(z.string().trim().max(18)).max(20).default([]),
  /** Also require a SIP username/password (digest auth) */
  useCredentials: z.boolean().default(false),
});
export const UpdateSipTrunkBody = z
  .object({
    name: z.string().trim().min(2).max(80),
    allowedIps: z.array(z.string().trim().max(18)).max(20),
    status: z.enum(["ACTIVE", "DISABLED"]),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Nothing to update");
export const AddSipNumberBody = z.object({
  number: TypedNumber,
  agentId: z.uuid().nullable().optional(),
  friendlyName: z.string().trim().max(80).optional(),
});

export const BlockCallerBody = z.object({
  /** A number, or a prefix ending in * (e.g. +882* for satellite ranges) */
  pattern: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{1,14}\*?$/, "A number in +country format, optionally ending in * for a whole range"),
  reason: z.string().trim().max(200).optional(),
});
