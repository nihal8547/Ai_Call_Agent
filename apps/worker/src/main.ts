import { createEmbeddingProvider, GeminiOcr } from "@platform/ai";
import { createPrismaClient } from "@platform/db";
import { QUEUES } from "@platform/shared";
import { createStorage } from "@platform/storage";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import path from "node:path";
import pino from "pino";
import { loadWorkerEnv } from "./env";
import { ingestionProcessor } from "./processors/ingestion";
import { processSystemJob } from "./processors/system";

async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const logger = pino({ level: env.LOG_LEVEL });
  // BullMQ workers need blocking connections without a per-request retry cap
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const prisma = createPrismaClient({ url: env.DATABASE_URL });
  const deps = {
    prisma,
    // Relative local storage paths resolve from the repository root, like the API
    storage: createStorage(env, path.resolve(__dirname, "../../..")),
    embeddings: createEmbeddingProvider(env.EMBEDDINGS_PROVIDER, { gemini: env.GEMINI_API_KEY }),
    ocr: env.GEMINI_API_KEY ? new GeminiOcr(env.GEMINI_API_KEY) : null,
  };
  logger.info(
    {
      embeddings: deps.embeddings?.model ?? "none (keyword search)",
      ocr: Boolean(deps.ocr),
      storage: env.STORAGE_DRIVER,
    },
    "knowledge pipeline configured",
  );

  const workers = [
    new Worker(QUEUES.system, processSystemJob, {
      connection,
      prefix: env.QUEUE_PREFIX,
      concurrency: env.WORKER_CONCURRENCY,
    }),
    new Worker(QUEUES.ingestion, ingestionProcessor(deps, logger), {
      connection,
      prefix: env.QUEUE_PREFIX,
      concurrency: Math.min(env.WORKER_CONCURRENCY, 2),
    }),
  ];

  for (const w of workers) {
    w.on("completed", (job) => logger.info({ queue: w.name, jobId: job.id }, "job completed"));
    w.on("failed", (job, err) => logger.error({ queue: w.name, jobId: job?.id, err }, "job failed"));
  }
  logger.info({ queues: workers.map((w) => w.name) }, "worker started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down: finishing active jobs");
    await Promise.all(workers.map((w) => w.close()));
    await prisma.$disconnect();
    connection.disconnect();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
