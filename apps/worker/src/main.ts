// Must be first: instrumentation patches modules as they load
import "./tracing";
import { createEmbeddingProvider, GeminiOcr } from "@platform/ai";
import { createPrismaClient } from "@platform/db";
import { priceTable, QUEUES } from "@platform/shared";
import { createStorage } from "@platform/storage";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import path from "node:path";
import { createServer } from "node:http";
import pino from "pino";
import { collectDefaultMetrics, Counter, Registry } from "prom-client";
import { loadWorkerEnv } from "./env";
import { analyticsProcessor } from "./processors/analytics";
import { ingestionProcessor } from "./processors/ingestion";
import { processSystemJob } from "./processors/system";
import { whatsappProcessor } from "./processors/whatsapp";

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
    prices: priceTable(env.USAGE_PRICES),
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
    new Worker(QUEUES.system, (job) => processSystemJob(job, { prisma, logger }), {
      connection,
      prefix: env.QUEUE_PREFIX,
      concurrency: env.WORKER_CONCURRENCY,
    }),
    new Worker(QUEUES.ingestion, ingestionProcessor(deps, logger), {
      connection,
      prefix: env.QUEUE_PREFIX,
      concurrency: Math.min(env.WORKER_CONCURRENCY, 2),
    }),
    new Worker(QUEUES.analytics, analyticsProcessor(prisma, logger), {
      connection,
      prefix: env.QUEUE_PREFIX,
      concurrency: 2,
    }),
    new Worker(QUEUES.whatsapp_inbound, whatsappProcessor(deps, logger), {
      connection,
      prefix: env.QUEUE_PREFIX,
      concurrency: Math.min(env.WORKER_CONCURRENCY, 4),
    }),
  ];


  // Periodic roll-up refresh (a repeatable job: one schedule however many workers run)
  const analytics = new Queue(QUEUES.analytics, { connection, prefix: env.QUEUE_PREFIX });
  await analytics.upsertJobScheduler(
    "analytics-sweep",
    { every: env.ANALYTICS_SWEEP_MINUTES * 60_000 },
    { name: "sweep", data: { kind: "sweep", hours: 3 }, opts: { removeOnComplete: 50, removeOnFail: 200 } },
  );

  const system = new Queue(QUEUES.system, { connection, prefix: env.QUEUE_PREFIX });
  await system.upsertJobScheduler(
    "retention-nightly",
    { pattern: "30 2 * * *", tz: "UTC" },
    { name: "retention", data: { type: "retention" }, opts: { removeOnComplete: 30, removeOnFail: 100 } },
  );
  await system.upsertJobScheduler(
    "trunk-health-hourly",
    { pattern: "7 * * * *", tz: "UTC" },
    {
      name: "trunk_health",
      data: { type: "trunk_health" },
      opts: { removeOnComplete: 30, removeOnFail: 100 },
    },
  );

  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const jobs = new Counter({
    name: "worker_jobs_total",
    help: "Jobs processed by queue and result",
    labelNames: ["queue", "result"] as const,
    registers: [registry],
  });
  for (const w of workers) {
    w.on("completed", (job) => {
      jobs.inc({ queue: w.name, result: "completed" });
      logger.info({ queue: w.name, jobId: job.id }, "job completed");
    });
    w.on("failed", (job, err) => {
      jobs.inc({ queue: w.name, result: "failed" });
      logger.error({ queue: w.name, jobId: job?.id, err }, "job failed");
    });
  }
  const metricsServer = env.WORKER_METRICS_PORT
    ? createServer((req, res) => {
        if (req.url !== "/metrics") return void res.writeHead(404).end();
        void registry
          .metrics()
          .then((body) => res.writeHead(200, { "content-type": registry.contentType }).end(body));
      }).listen(env.WORKER_METRICS_PORT)
    : null;
  logger.info({ queues: workers.map((w) => w.name) }, "worker started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down: finishing active jobs");
    metricsServer?.close();
    await Promise.all(workers.map((w) => w.close()));
    await analytics.close();
    await system.close();
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
