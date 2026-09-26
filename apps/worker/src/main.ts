import { QUEUES } from "@platform/shared";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import pino from "pino";
import { loadWorkerEnv } from "./env";
import { processSystemJob } from "./processors/system";

async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const logger = pino({ level: env.LOG_LEVEL });
  // BullMQ workers need blocking connections without a per-request retry cap
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const workers = [
    new Worker(QUEUES.system, processSystemJob, { connection, concurrency: env.WORKER_CONCURRENCY }),
  ];

  for (const w of workers) {
    w.on("completed", (job) => logger.info({ queue: w.name, jobId: job.id }, "job completed"));
    w.on("failed", (job, err) => logger.error({ queue: w.name, jobId: job?.id, err }, "job failed"));
  }
  logger.info({ queues: workers.map((w) => w.name) }, "worker started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down: finishing active jobs");
    await Promise.all(workers.map((w) => w.close()));
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
