export type Limits = {
  maxAgents: number;
  maxCallsPerDay: number;
  maxCallMinutesPerMonth: number;
  maxDocuments: number;
  maxStorageMb: number;
  maxDocumentSizeMb: number;
  maxLlmTokensPerDay: number;
};

export type PlatformBusiness = {
  id: string;
  name: string;
  slug: string;
  status: "ACTIVE" | "SUSPENDED";
  statusReason: string | null;
  statusChangedAt: string | null;
  plan: string;
  country: string;
  createdAt: string;
  ownerEmail: string | null;
  members: number;
  agents: number;
  phoneNumbers: number;
  whatsappNumbers: number;
  calls30d: number;
  minutes30d: number;
  costMicros30d: number;
  failedJobs: number;
  lastCallAt: string | null;
  limits: Limits;
};

export type PlatformBusinessDetail = PlatformBusiness & {
  history: { action: string; before: unknown; after: unknown; at: string; by: string }[];
};

export const usd = (micros: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(
    micros / 1_000_000,
  );
