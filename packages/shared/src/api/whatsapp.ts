import { z } from "zod";

/** Meta ids (WhatsApp Business account, phone number): digits only */
const MetaId = z
  .string()
  .trim()
  .regex(/^\d{5,30}$/, "Must be the numeric id from Meta");

/** "Continue with Facebook": what Meta's Embedded Signup popup returns to the browser */
export const WhatsAppEmbeddedSignupBody = z.object({
  code: z.string().trim().min(10).max(2000),
  wabaId: MetaId,
  phoneNumberId: MetaId,
  agentId: z.uuid().nullish(),
  /**
   * The number stays on the WhatsApp Business app (Meta's "coexistence" onboarding): the owner
   * keeps chatting on the phone, and the number isn't registered again.
   */
  onBusinessApp: z.boolean().default(false),
});
export type WhatsAppEmbeddedSignupBody = z.infer<typeof WhatsAppEmbeddedSignupBody>;

/** Finish registering a number; the owner's two-step verification PIN if they set one */
export const RegisterWhatsAppNumberBody = z.object({
  pin: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "The PIN has 6 digits")
    .optional(),
});

/** Other way to connect: a permanent System User token from the business's own Meta setup */
export const WhatsAppManualConnectBody = z.object({
  accessToken: z
    .string()
    .trim()
    .min(20, "Paste the whole access token")
    .max(1000)
    .regex(/^[A-Za-z0-9_-]+$/, "That doesn't look like a Meta access token"),
  wabaId: MetaId,
  phoneNumberId: MetaId,
  agentId: z.uuid().nullish(),
});
export type WhatsAppManualConnectBody = z.infer<typeof WhatsAppManualConnectBody>;

/** How a WhatsApp number's agent behaves (stored on whatsapp_numbers.settings) */
export const WhatsAppNumberSettings = z.object({
  /** Answering a voice note: with a voice note, in writing, or both */
  voiceReplies: z.enum(["voice", "text", "both"]).default("voice"),
  /** Gemini voice used for spoken replies */
  voice: z.enum(["Kore", "Aoede", "Puck", "Charon"]).default("Kore"),
});
export type WhatsAppNumberSettings = z.infer<typeof WhatsAppNumberSettings>;

export const UpdateWhatsAppNumberBody = z
  .object({
    agentId: z.uuid().nullable().optional(),
    settings: WhatsAppNumberSettings.partial().optional(),
  })
  .refine((b) => b.agentId !== undefined || b.settings !== undefined, "Nothing to change");

export const WhatsAppTestMessageBody = z.object({
  to: z
    .string()
    // People type numbers with spaces, dashes and brackets
    .transform((v) => v.replace(/[\s\-().]/g, ""))
    .pipe(
      z
        .string()
        .regex(/^\+?[1-9]\d{6,14}$/, "Use the full number with the country code, e.g. +974 5512 3456"),
    ),
});

export const CHAT_FILTERS = ["open", "ai", "human", "unread", "closed"] as const;
export const ChatListQuery = z.object({
  filter: z.enum(CHAT_FILTERS).default("open"),
  q: z.string().trim().max(60).optional(),
  /** Conversations with an older last message than this (ISO time) */
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});

export const ChatMessagesQuery = z.object({
  /** Messages older than this message id */
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const ChatReplyBody = z.object({
  text: z.string().trim().min(1, "Type a message").max(4096),
});

export const ChatModeBody = z.object({ mode: z.enum(["AI", "HUMAN", "CLOSED"]) });

/** Free-form messages are allowed for 24 hours after the customer's last message */
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;
