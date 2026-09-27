import { envPrimitives, parseEnv, priceTable } from "@platform/shared";
import { StorageEnvSchema } from "@platform/storage";
import { z } from "zod";

export const ApiEnvSchema = z
  .object({
    NODE_ENV: envPrimitives.nodeEnv,
    API_PORT: envPrimitives.port.default(4000),
    API_HOST: z.string().default("0.0.0.0"),
    /**
     * Addresses of reverse proxies allowed to set X-Forwarded-For (comma-separated IPs/CIDRs, or
     * "loopback"/"linklocal"/"uniquelocal"). Include the web app's proxy and any load balancer.
     * Requests from other peers use the socket address, so clients cannot spoof their IP to dodge rate limits.
     */
    TRUST_PROXY: envPrimitives.csv,
    LOG_LEVEL: envPrimitives.logLevel,
    DATABASE_URL: envPrimitives.postgresUrl,
    REDIS_URL: envPrimitives.redisUrl,
    /** BullMQ key prefix; separate prefixes keep environments sharing a Redis apart */
    QUEUE_PREFIX: z
      .string()
      .regex(/^[\w-]{1,32}$/)
      .default("bull"),
    /**
     * Run the call-side job consumers (webhooks, notifications, CRM) in this process. Turn off on
     * API instances that should only serve requests; at least one instance must keep them on.
     */
    QUEUE_CONSUMERS: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    /** Multiplies retry backoff delays (tests use a tiny factor) */
    QUEUE_BACKOFF_SCALE: z.coerce.number().min(0.0001).max(10).default(1),
    /** Bearer token Prometheus sends to /metrics; without it only private-network scrapers are answered */
    METRICS_TOKEN: z.string().min(16).optional(),
    /** Send traces to an OpenTelemetry collector (OTLP/HTTP), e.g. http://otel-collector:4318 */
    OTEL_EXPORTER_OTLP_ENDPOINT: envPrimitives.url.optional(),
    /** Enables the queue dashboard at /admin/queues (HTTP basic auth, user "admin"). Platform operators only. */
    ADMIN_BOARD_PASSWORD: z.string().min(16).optional(),
    /** Origins allowed to call the API directly (the web app normally goes through its same-origin proxy) */
    CORS_ORIGINS: envPrimitives.csv,
    /** Public HTTPS base URL of this API, used to build telephony webhook URLs */
    PUBLIC_BASE_URL: envPrimitives.url.default("http://localhost:4000"),
    /** Base URL of the web app, used in invitation links */
    WEB_BASE_URL: envPrimitives.url.default("http://localhost:3000"),
    /**
     * The platform's own mail server, for invitations and password resets (not the businesses'
     * SMTP integrations): smtp://user:pass@host:587 (STARTTLS) or smtps://user:pass@host:465.
     * Without it, invitation links are shown to copy and reset links are only logged in development.
     */
    /**
     * "Connect with Microsoft" for Outlook / Microsoft 365 email (Entra ID app registration,
     * redirect URI <WEB_BASE_URL>/api/v1/integrations/oauth/microsoft/callback)
     */
    MICROSOFT_CLIENT_ID: z.string().min(10).optional(),
    MICROSOFT_CLIENT_SECRET: z.string().min(10).optional(),
    SMTP_URL: z
      .string()
      .regex(/^smtps?:\/\/.+/, "smtp:// or smtps:// URL")
      .optional(),
    /**
     * "required": a new account confirms its email (the emailed link) before buying numbers,
     * connecting WhatsApp or SIP, or creating API keys. "off" for installs without email.
     */
    EMAIL_VERIFICATION: z.enum(["required", "off"]).default("required"),
    /** Recorded with each acceptance at sign-up; change it when the terms change */
    TERMS_VERSION: z
      .string()
      .regex(/^[\w.-]{1,40}$/)
      .default("1"),
    MAIL_FROM: z.string().min(3).max(200).default("Voice Agent Platform <no-reply@localhost>"),
    /** HMAC key for access tokens (≥ 32 characters) */
    JWT_SECRET: z.string().min(32, "must be at least 32 characters"),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    /** Secure cookies (HTTPS only). Defaults to true outside development/test. */
    COOKIE_SECURE: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === "true")),
    MASTER_ENCRYPTION_KEY: envPrimitives.key32,
    /** Twilio account auth token (validates webhook signatures). Telephony endpoints return 503 without it. */
    TWILIO_AUTH_TOKEN: z.string().min(16).optional(),
    /**
     * Twilio account for buying numbers and creating SIP domains from the app (AC…). With an API key
     * (SK… + secret) the REST calls use it; otherwise the account SID and auth token.
     */
    TWILIO_ACCOUNT_SID: z
      .string()
      .regex(/^AC[0-9a-fA-F]{32}$/, "must be an account SID (AC…)")
      .optional(),
    TWILIO_API_KEY_SID: z
      .string()
      .regex(/^SK[0-9a-fA-F]{32}$/, "must be an API key SID (SK…)")
      .optional(),
    TWILIO_API_KEY_SECRET: z.string().min(16).optional(),
    /** Base URL of Twilio's REST API (tests point it at a fake) */
    TWILIO_API_BASE_URL: envPrimitives.url.default("https://api.twilio.com"),
    /**
     * Streaming voice (Twilio ConversationRelay) for agents set to it. "false" answers every call
     * turn by turn (<Gather>) whatever the agents say, e.g. if the WebSocket can't be reached.
     */
    VOICE_STREAMING: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    /** Streaming: re-prompt a silent caller this long after the agent's words should have finished */
    RELAY_SILENCE_MS: z.coerce.number().int().min(200).max(60_000).default(8000),
    /** Streaming: how long speech takes per character (for the silence timer); ~14 characters a second */
    RELAY_SPEECH_CHAR_MS: z.coerce.number().int().min(0).max(500).default(70),
    /** Streaming: say "one moment" when a reply takes longer than this (0 = never) */
    RELAY_FILLER_MS: z.coerce.number().int().min(0).max(30_000).default(3000),
    /** Without it, calls run on deterministic understanding and wording */
    GEMINI_API_KEY: z.string().min(10).optional(),
    /** Country calling code for phone numbers spoken without one */
    DEFAULT_COUNTRY_CODE: z
      .string()
      .regex(/^\d{1,3}$/)
      .default("91"),
    /** "auto" uses Gemini when GEMINI_API_KEY is set, otherwise keyword search only */
    EMBEDDINGS_PROVIDER: z.enum(["auto", "gemini", "hashing", "none"]).default("auto"),
    /** Google OAuth client (web application) for "Connect with Google"; service-account keys work without it */
    GOOGLE_OAUTH_CLIENT_ID: z.string().min(10).optional(),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(10).optional(),
    /**
     * Meta app for WhatsApp (Cloud API). META_APP_SECRET checks webhook signatures and exchanges
     * Embedded Signup codes; without it the WhatsApp webhook refuses everything.
     */
    META_APP_ID: z
      .string()
      .regex(/^\d{5,20}$/, "must be the numeric Meta app id")
      .optional(),
    META_APP_SECRET: z.string().min(16).optional(),
    /** Facebook Login for Business configuration for WhatsApp Embedded Signup ("Continue with Facebook") */
    META_EMBEDDED_SIGNUP_CONFIG_ID: z
      .string()
      .regex(/^\d{5,30}$/)
      .optional(),
    /** Token Meta echoes when the webhook URL is verified (random, ≥ 16 characters) */
    WHATSAPP_VERIFY_TOKEN: z.string().min(16).optional(),
    META_GRAPH_VERSION: z
      .string()
      .regex(/^v\d{1,3}\.\d$/)
      .default("v23.0"),
    /** How long the agent waits for more messages before answering (customers often send several) */
    WHATSAPP_REPLY_DELAY_MS: z.coerce.number().int().min(0).max(30_000).default(2500),
    /** Largest file downloaded from WhatsApp (voice notes, documents) */
    WHATSAPP_MEDIA_MAX_MB: z.coerce.number().int().min(1).max(100).default(16),
    /** Longer voice notes aren't transcribed: the customer is asked for a shorter one */
    WHATSAPP_VOICE_MAX_SECONDS: z.coerce.number().int().min(10).max(900).default(180),
    /** Gemini text-to-speech model for voice replies */
    GEMINI_TTS_MODEL: z.string().min(3).max(80).optional(),
    /** Gemini API origin for speech (tests point it at a fake) */
    GEMINI_API_BASE_URL: envPrimitives.url.default("https://generativelanguage.googleapis.com/v1beta"),
    /** Graph API origin (tests point it at a fake) */
    META_GRAPH_BASE_URL: envPrimitives.url.default("https://graph.facebook.com"),
    /** HubSpot public app for "Connect with HubSpot"; private-app tokens work without it */
    HUBSPOT_CLIENT_ID: z.string().min(10).optional(),
    HUBSPOT_CLIENT_SECRET: z.string().min(10).optional(),
    /** Zoho API console client (server-based) for "Connect with Zoho"; Self Client tokens work without it */
    ZOHO_CLIENT_ID: z.string().min(10).optional(),
    ZOHO_CLIENT_SECRET: z.string().min(10).optional(),
    /**
     * Let webhooks and SMTP reach private/loopback addresses. Development and tests only:
     * in production it would let tenants probe the internal network.
     */
    ALLOW_PRIVATE_NETWORK_TOOLS: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    /**
     * Your own rates for usage cost estimates, as JSON in micro-dollars per unit, e.g.
     * {"TELEPHONY_MINUTES":10000,"LLM_INPUT_TOKENS:gemini-2.5-pro":1.25}. Defaults are list prices.
     */
    USAGE_PRICES: z
      .string()
      .optional()
      .refine((v) => {
        if (!v) return true;
        try {
          priceTable(v);
          return true;
        } catch {
          return false;
        }
      }, "must be a JSON object of KIND or KIND:model → micro-dollars per unit"),
    /** Largest accepted document upload */
    MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(200).default(50),
  })
  .extend(StorageEnvSchema.shape);

export type ApiEnv = z.infer<typeof ApiEnvSchema> & { COOKIE_SECURE: boolean };

export const API_ENV = Symbol("API_ENV");

export function loadApiEnv(source: Record<string, string | undefined> = process.env): ApiEnv {
  const env = parseEnv(ApiEnvSchema, source);
  if (env.NODE_ENV === "production" && env.ALLOW_PRIVATE_NETWORK_TOOLS)
    throw new Error("ALLOW_PRIVATE_NETWORK_TOOLS must not be enabled in production");
  return { ...env, COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === "production" };
}
