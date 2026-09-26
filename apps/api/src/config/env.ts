import { envPrimitives, parseEnv } from "@platform/shared";
import { z } from "zod";

export const ApiEnvSchema = z.object({
  NODE_ENV: envPrimitives.nodeEnv,
  API_PORT: envPrimitives.port.default(4000),
  API_HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: envPrimitives.logLevel,
  DATABASE_URL: envPrimitives.postgresUrl,
  REDIS_URL: envPrimitives.redisUrl,
  /** Origins allowed to call the API directly (the web app normally goes through its same-origin proxy) */
  CORS_ORIGINS: envPrimitives.csv,
  /** Public HTTPS base URL of this API, used to build telephony webhook URLs */
  PUBLIC_BASE_URL: envPrimitives.url.default("http://localhost:4000"),
});

export type ApiEnv = z.infer<typeof ApiEnvSchema>;

export const API_ENV = Symbol("API_ENV");

export function loadApiEnv(source: Record<string, string | undefined> = process.env): ApiEnv {
  return parseEnv(ApiEnvSchema, source);
}
