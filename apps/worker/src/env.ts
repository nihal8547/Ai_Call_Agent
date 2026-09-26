import { envPrimitives, parseEnv } from "@platform/shared";
import { z } from "zod";

export const WorkerEnvSchema = z.object({
  NODE_ENV: envPrimitives.nodeEnv,
  LOG_LEVEL: envPrimitives.logLevel,
  REDIS_URL: envPrimitives.redisUrl,
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
});
export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;

export const loadWorkerEnv = (source: Record<string, string | undefined> = process.env): WorkerEnv =>
  parseEnv(WorkerEnvSchema, source);
