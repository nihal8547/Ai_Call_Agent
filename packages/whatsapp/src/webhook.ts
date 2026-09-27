import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Meta signs every webhook with the app secret: `X-Hub-Signature-256: sha256=<hex HMAC of the raw
 * body>`. The raw bytes must be used (re-serialised JSON would not match).
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice(7), "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const MESSAGE_TYPES = [
  "TEXT",
  "AUDIO",
  "IMAGE",
  "DOCUMENT",
  "VIDEO",
  "STICKER",
  "LOCATION",
  "CONTACTS",
  "INTERACTIVE",
  "REACTION",
  "UNSUPPORTED",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export type InboundMessage = {
  kind: "message";
  phoneNumberId: string;
  /** The customer's WhatsApp id: their number in international format without "+" */
  from: string;
  profileName: string | null;
  wamid: string;
  timestamp: Date;
  type: MessageType;
  /** Text, caption, button title, emoji, or a short description (location, contacts) */
  text: string | null;
  media: { id: string; mimeType: string; filename: string | null; voice: boolean } | null;
  /** The message this one replies to (quoted) or reacts to */
  replyTo: string | null;
};

export type DeliveryStatus = "sent" | "delivered" | "read" | "failed";

export type StatusUpdate = {
  kind: "status";
  phoneNumberId: string;
  wamid: string;
  status: DeliveryStatus;
  timestamp: Date;
  recipient: string;
  error: { code: number; title: string; detail: string | null } | null;
};

export type WebhookEvent = InboundMessage | StatusUpdate;

// Lenient schemas: Meta adds fields over time; unknown fields are ignored, unknown types kept as UNSUPPORTED
const Media = z.object({
  id: z.string(),
  mime_type: z.string().default("application/octet-stream"),
  caption: z.string().optional(),
  filename: z.string().optional(),
  voice: z.boolean().optional(),
});

const RawMessage = z.looseObject({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.string(),
  context: z.looseObject({ id: z.string().optional() }).optional(),
  text: z.object({ body: z.string() }).optional(),
  image: Media.optional(),
  audio: Media.optional(),
  video: Media.optional(),
  document: Media.optional(),
  sticker: Media.optional(),
  location: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
      name: z.string().optional(),
      address: z.string().optional(),
    })
    .optional(),
  contacts: z
    .array(
      z.looseObject({
        name: z.looseObject({ formatted_name: z.string().optional() }).optional(),
        phones: z.array(z.looseObject({ phone: z.string().optional() })).optional(),
      }),
    )
    .optional(),
  interactive: z
    .looseObject({
      button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
      list_reply: z.object({ id: z.string(), title: z.string() }).optional(),
    })
    .optional(),
  button: z.object({ text: z.string(), payload: z.string().optional() }).optional(),
  reaction: z.object({ message_id: z.string(), emoji: z.string().optional() }).optional(),
});

const RawStatus = z.looseObject({
  id: z.string(),
  status: z.string(),
  timestamp: z.string(),
  recipient_id: z.string(),
  errors: z
    .array(
      z.looseObject({
        code: z.number(),
        title: z.string().optional(),
        message: z.string().optional(),
        error_data: z.looseObject({ details: z.string().optional() }).optional(),
      }),
    )
    .optional(),
});

const Payload = z.looseObject({
  object: z.string(),
  entry: z.array(
    z.looseObject({
      id: z.string().optional(),
      changes: z.array(
        z.looseObject({
          field: z.string(),
          value: z.looseObject({
            metadata: z.looseObject({ phone_number_id: z.string() }).optional(),
            contacts: z
              .array(
                z.looseObject({
                  wa_id: z.string(),
                  profile: z.looseObject({ name: z.string().optional() }).optional(),
                }),
              )
              .optional(),
            messages: z.array(z.unknown()).optional(),
            statuses: z.array(z.unknown()).optional(),
          }),
        }),
      ),
    }),
  ),
});

const at = (unixSeconds: string) => new Date(Number(unixSeconds) * 1000);

function normaliseMessage(
  m: z.infer<typeof RawMessage>,
  phoneNumberId: string,
  names: Map<string, string>,
): InboundMessage {
  const base = {
    kind: "message" as const,
    phoneNumberId,
    from: m.from,
    profileName: names.get(m.from) ?? null,
    wamid: m.id,
    timestamp: at(m.timestamp),
    replyTo: m.context?.id ?? null,
    media: null,
  };
  const media = (x: z.infer<typeof Media>, voice = false) => ({
    id: x.id,
    mimeType: x.mime_type,
    filename: x.filename ?? null,
    voice: voice || Boolean(x.voice),
  });
  switch (m.type) {
    case "text":
      return { ...base, type: "TEXT", text: m.text?.body ?? "" };
    case "audio":
      return m.audio ? { ...base, type: "AUDIO", text: null, media: media(m.audio) } : unsupported(base);
    case "image":
      return m.image
        ? { ...base, type: "IMAGE", text: m.image.caption ?? null, media: media(m.image) }
        : unsupported(base);
    case "video":
      return m.video
        ? { ...base, type: "VIDEO", text: m.video.caption ?? null, media: media(m.video) }
        : unsupported(base);
    case "document":
      return m.document
        ? { ...base, type: "DOCUMENT", text: m.document.caption ?? null, media: media(m.document) }
        : unsupported(base);
    case "sticker":
      return m.sticker
        ? { ...base, type: "STICKER", text: null, media: media(m.sticker) }
        : unsupported(base);
    case "location": {
      const l = m.location;
      if (!l) return unsupported(base);
      const label = [l.name, l.address].filter(Boolean).join(", ");
      return {
        ...base,
        type: "LOCATION",
        text: `${label ? `${label} ` : ""}(${l.latitude}, ${l.longitude})`,
      };
    }
    case "contacts": {
      const list = (m.contacts ?? [])
        .map((c) => [c.name?.formatted_name, c.phones?.[0]?.phone].filter(Boolean).join(" "))
        .filter(Boolean);
      return { ...base, type: "CONTACTS", text: list.join("; ") || null };
    }
    case "interactive": {
      const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
      return { ...base, type: "INTERACTIVE", text: r?.title ?? null };
    }
    case "button":
      return { ...base, type: "INTERACTIVE", text: m.button?.text ?? null };
    case "reaction":
      return {
        ...base,
        type: "REACTION",
        text: m.reaction?.emoji ?? null,
        replyTo: m.reaction?.message_id ?? null,
      };
    default:
      return unsupported(base);
  }
}

function unsupported(base: Omit<InboundMessage, "type" | "text">): InboundMessage {
  return { ...base, type: "UNSUPPORTED", text: null, media: null };
}

const STATUSES: readonly DeliveryStatus[] = ["sent", "delivered", "read", "failed"];

/**
 * Every message and delivery status in a webhook call, in order. Anything unrecognised (other
 * fields, malformed items) is skipped rather than failing the whole delivery.
 */
export function parseWebhook(body: unknown): WebhookEvent[] {
  const payload = Payload.safeParse(body);
  if (!payload.success || payload.data.object !== "whatsapp_business_account") return [];
  const events: WebhookEvent[] = [];
  for (const entry of payload.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages") continue;
      const v = change.value;
      const phoneNumberId = v.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      const names = new Map(
        (v.contacts ?? []).flatMap((c) => (c.profile?.name ? [[c.wa_id, c.profile.name] as const] : [])),
      );
      for (const raw of v.messages ?? []) {
        const m = RawMessage.safeParse(raw);
        if (m.success) events.push(normaliseMessage(m.data, phoneNumberId, names));
      }
      for (const raw of v.statuses ?? []) {
        const s = RawStatus.safeParse(raw);
        if (!s.success || !STATUSES.includes(s.data.status as DeliveryStatus)) continue;
        const e = s.data.errors?.[0];
        events.push({
          kind: "status",
          phoneNumberId,
          wamid: s.data.id,
          status: s.data.status as DeliveryStatus,
          timestamp: at(s.data.timestamp),
          recipient: s.data.recipient_id,
          error: e
            ? {
                code: e.code,
                title: e.title ?? e.message ?? "Delivery failed",
                detail: e.error_data?.details ?? null,
              }
            : null,
        });
      }
    }
  }
  return events;
}

/** A WhatsApp id ("97455123456") as E.164 ("+97455123456") */
export const waIdToE164 = (waId: string) => `+${waId.replace(/\D/g, "")}`;
