export type Page<T> = { items: T[]; nextCursor: string | null };

export type Summary = {
  days: number;
  totals: {
    calls: number;
    answered: number;
    completed: number;
    failed: number;
    qualified: number;
    booked: number;
    transfers: number;
    followUps: number;
    leads: number;
    avgDurationSec: number | null;
    conversionRate: number;
    fallbackRate: number;
  };
  series: { day: string; calls: number; booked: number; qualified: number }[];
};

export type AgentListItem = {
  id: string;
  name: string;
  description: string | null;
  status: "ACTIVE" | "INACTIVE" | "ARCHIVED";
  templateKey: string | null;
  publishedVersion: { version: number; publishedAt: string } | null;
  hasDraft: boolean;
  phoneNumbers: string[];
  calls: number;
};

export type AgentVersionView = {
  id: string;
  version: number;
  status: string;
  config: AgentConfigJson;
  changeNote: string | null;
  publishedAt: string | null;
};
export type AgentDetail = {
  id: string;
  name: string;
  description: string | null;
  status: AgentListItem["status"];
  templateKey: string | null;
  phoneNumbers: { id: string; e164: string }[];
  published: AgentVersionView | null;
  draft: AgentVersionView | null;
};

export type FieldJson = {
  key: string;
  label: string;
  question: string;
  type: string;
  options: string[];
  required: boolean;
  [k: string]: unknown;
};
export type StepJson = {
  id: string;
  type: string;
  fields?: string[];
  resetOnDecline?: string[];
  [k: string]: unknown;
};
export type AgentConfigJson = {
  businessName: string;
  agentName: string;
  greeting: string;
  persona: string;
  instructions: string;
  businessRules: string[];
  qualificationFields: FieldJson[];
  workflow: { steps: StepJson[]; answerQuestions: boolean };
  [k: string]: unknown;
};

export type Template = { key: string; name: string; industry: string; description: string };

export type CallListItem = {
  id: string;
  fromNumber: string;
  toNumber: string;
  status: string;
  outcome: string;
  qualificationStatus: string;
  startedAt: string;
  durationSec: number | null;
  totalTurns: number;
  fallbackTurns: number;
  agent: { id: string; name: string };
};
export type CallDetail = CallListItem & {
  collectedData: Record<string, unknown>;
  summary: string | null;
  endedAt: string | null;
  agentVersion: { id: string; version: number };
  leads: { id: string; customerName: string | null; status: { label: string } }[];
  appointments: { id: string; title: string; startsAt: string; status: string }[];
};
export type CallEvent = {
  id: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  latencyMs: number | null;
  createdAt: string;
};

export type LeadStatus = {
  id: string;
  key: string;
  label: string;
  color: string;
  sortOrder: number;
  isDefault: boolean;
  isTerminal: boolean;
};
export type Lead = {
  id: string;
  customerName: string | null;
  phone: string | null;
  email: string | null;
  data: Record<string, unknown>;
  notes: string | null;
  createdAt: string;
  callId: string | null;
  status: { id: string; key: string; label: string; color: string };
  agent: { id: string; name: string } | null;
  /** Per CRM integration id */
  crmSync?: Record<
    string,
    {
      status: "pending" | "synced" | "failed";
      externalId: string | null;
      syncedAt: string | null;
      error: string | null;
    }
  >;
};

export type PhoneNumber = {
  id: string;
  e164: string;
  friendlyName: string | null;
  isActive: boolean;
  agent: { id: string; name: string; status: string } | null;
};

export type DocumentStatus = "UPLOADING" | "PROCESSING" | "EXTRACTING" | "EMBEDDING" | "READY" | "FAILED";

export type KnowledgeCollection = {
  id: string;
  name: string;
  description: string | null;
  settings: { targetTokens?: number; overlapTokens?: number };
  documentCount: number;
  createdAt: string;
};

export type KnowledgeDocument = {
  id: string;
  collectionId: string;
  title: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: DocumentStatus;
  statusMessage: string | null;
  progress: number;
  enabled: boolean;
  version: number;
  replacesId: string | null;
  pageCount: number | null;
  chunkCount: number;
  metadata: { kind?: string; ocr?: boolean; embedded?: boolean; embeddingModel?: string | null };
  processedAt: string | null;
  createdAt: string;
  agents: { id: string; name: string }[];
};

export type DocumentDetail = KnowledgeDocument & {
  preview: { ordinal: number; content: string; tokenCount: number; metadata: ChunkMeta }[];
};

export type ChunkMeta = {
  page?: number;
  pages?: number[];
  headingPath?: string[];
  sheet?: string;
  rows?: [number, number];
};

export type SearchHit = {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  content: string;
  metadata: ChunkMeta;
  vectorScore: number | null;
  textScore: number | null;
  score: number;
};

export type IntegrationStatus = "CONNECTED" | "ERROR" | "EXPIRED" | "DISCONNECTED";

export type Integration = {
  id: string;
  type: string;
  name: string;
  status: IntegrationStatus;
  config: Record<string, unknown>;
  lastError: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  usedBy: { tool: string; agent: { id: string; name: string } }[];
  /** Only in the response that created it (webhooks) */
  signingSecret?: string;
};

export type ToolBinding = {
  toolName: string;
  enabled: boolean;
  integration: { id: string; name: string; type: string; status: IntegrationStatus } | null;
};

export type AppointmentStatus = "UPCOMING" | "COMPLETED" | "CANCELLED" | "RESCHEDULED" | "NO_SHOW";

export type Appointment = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: AppointmentStatus;
  notes: string | null;
  externalRef: string | null;
  rescheduledFromId: string | null;
  callId: string | null;
  createdAt: string;
  agent: { id: string; name: string } | null;
  lead: { id: string; customerName: string | null; phone: string | null } | null;
  integration: { id: string; name: string; type: string } | null;
};
