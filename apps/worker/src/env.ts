import { envPrimitives, parseEnv } from "@platform/shared";
import { StorageEnvSchema } from "@platform/storage";
import { z } from "zod";

export const WorkerEnvSchema = z
  .object({
    NODE_ENV: envPrimitives.nodeEnv,
    LOG_LEVEL: envPrimitives.logLevel,
    REDIS_URL: envPrimitives.redisUrl,
    /** BullMQ key prefix; separate prefixes keep environments sharing a Redis apart */
    QUEUE_PREFIX: z
      .string()
      .regex(/^[\w-]{1,32}$/)
      .default("bull"),
    DATABASE_URL: envPrimitives.postgresUrl,
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
    GEMINI_API_KEY: z.string().min(10).optional(),
    EMBEDDINGS_PROVIDER: z.enum(["auto", "gemini", "hashing", "none"]).default("auto"),
    /** Your own unit prices for cost estimates (same format as the API's USAGE_PRICES) */
    USAGE_PRICES: z.string().optional(),
    /** How often analytics roll-ups are refreshed for tenants with recent calls */
    /** Prometheus metrics on this port (0 = off); expose only inside the private network */
    WORKER_METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9464),
    ANALYTICS_SWEEP_MINUTES: z.coerce.number().int().min(1).max(1440).default(10),
  })
  .extend(StorageEnvSchema.shape);
export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;

export const loadWorkerEnv = (source: Record<string, string | undefined> = process.env): WorkerEnv =>
  parseEnv(WorkerEnvSchema, source);
