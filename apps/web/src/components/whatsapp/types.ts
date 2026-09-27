export type WhatsAppNumber = {
  id: string;
  phoneNumberId: string;
  wabaId: string;
  displayNumber: string;
  verifiedName: string | null;
  status: "CONNECTED" | "PENDING" | "DISCONNECTED";
  qualityRating: string | null;
  lastError: string | null;
  connectedAt: string;
  agent: { id: string; name: string; status: string } | null;
};

export type WhatsAppOverview = {
  platform: {
    embeddedSignup: boolean;
    appId: string | null;
    configId: string | null;
    graphVersion: string;
    webhookUrl: string;
    webhookReady: boolean;
  };
  numbers: WhatsAppNumber[];
};

export type ConversationMode = "AI" | "HUMAN" | "CLOSED";

export type ConversationSummary = {
  id: string;
  contactName: string | null;
  contactPhone: string;
  mode: ConversationMode;
  lastMessageAt: string;
  lastMessagePreview: string | null;
  lastInboundAt: string | null;
  windowClosesAt: string | null;
  unreadCount: number;
  whatsappNumber: {
    id: string;
    displayNumber: string;
    verifiedName: string | null;
    status: string;
    agent?: { name: string; status: string } | null;
  };
  agent: { id: string; name: string } | null;
};

export type ConversationDetail = ConversationSummary & {
  contactWaId: string;
  closedAt: string | null;
  lead: { id: string; customerName: string | null; status: { label: string } } | null;
};

export type ChatMessage = {
  id: string;
  direction: "INBOUND" | "OUTBOUND" | "INTERNAL";
  sender: "CUSTOMER" | "AI" | "STAFF" | "SYSTEM";
  type: string;
  text: string | null;
  mediaMime: string | null;
  mediaFilename: string | null;
  transcript: string | null;
  status: "RECEIVED" | "QUEUED" | "SENT" | "DELIVERED" | "READ" | "FAILED";
  errorCode: number | null;
  errorTitle: string | null;
  sentAt: string | null;
  createdAt: string;
  sentByName: string | null;
  /** Agent replies: what they were based on (staff only) */
  meta?: {
    sources?: { documentId: string; title: string; page?: number }[];
    tools?: { tool: string; ok: boolean; error: string | null }[];
    control?: "transfer" | "hangup";
  } | null;
};
