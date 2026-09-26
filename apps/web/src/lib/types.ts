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
};

export type PhoneNumber = {
  id: string;
  e164: string;
  friendlyName: string | null;
  isActive: boolean;
  agent: { id: string; name: string; status: string } | null;
};
