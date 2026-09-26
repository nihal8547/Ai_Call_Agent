import { envPrimitives, parseEnv } from "@platform/shared";
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
    /** Origins allowed to call the API directly (the web app normally goes through its same-origin proxy) */
    CORS_ORIGINS: envPrimitives.csv,
    /** Public HTTPS base URL of this API, used to build telephony webhook URLs */
    PUBLIC_BASE_URL: envPrimitives.url.default("http://localhost:4000"),
    /** Base URL of the web app, used in invitation links */
    WEB_BASE_URL: envPrimitives.url.default("http://localhost:3000"),
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
    /** Without it, calls run on deterministic understanding and wording */
    GEMINI_API_KEY: z.string().min(10).optional(),
    /** Country calling code for phone numbers spoken without one */
    DEFAULT_COUNTRY_CODE: z
      .string()
      .regex(/^\d{1,3}$/)
      .default("91"),
    /** "auto" uses Gemini when GEMINI_API_KEY is set, otherwise keyword search only */
    EMBEDDINGS_PROVIDER: z.enum(["auto", "gemini", "hashing", "none"]).default("auto"),
    /** Largest accepted document upload */
    MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(200).default(50),
  })
  .extend(StorageEnvSchema.shape);

export type ApiEnv = z.infer<typeof ApiEnvSchema> & { COOKIE_SECURE: boolean };

export const API_ENV = Symbol("API_ENV");

export function loadApiEnv(source: Record<string, string | undefined> = process.env): ApiEnv {
  const env = parseEnv(ApiEnvSchema, source);
  return { ...env, COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === "production" };
}
