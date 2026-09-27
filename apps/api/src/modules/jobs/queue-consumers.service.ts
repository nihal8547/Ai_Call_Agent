import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { QUEUES, type QueueJob } from "@platform/shared";
import { type Job, Worker } from "bullmq";
import { Redis } from "ioredis";
import { API_ENV, type ApiEnv } from "../../config/env";
import { DeadLetterService } from "./dead-letter.service";
import { JobProcessors } from "./job-processors.service";

type TenantQueue = "webhooks" | "notifications" | "crm" | "whatsapp";
const CONSUMERS: [TenantQueue, number][] = [
  [QUEUES.webhooks, 10],
  [QUEUES.notifications, 5],
  [QUEUES.crm, 5],
  [QUEUES.whatsapp, 10],
];

/** Did this failure use up the job's attempts (or was it not worth retrying)? */
export function isFinalFailure(job: Job, err: Error): boolean {
  return err.name === "UnrecoverableError" || job.attemptsMade >= (job.opts.attempts ?? 1);
}

/**
 * Consumers for the call-side queues. They run in the API process because they need the same
 * services as live calls (tenant keys, integrations, tool grants); ingestion and analytics run in
 * the worker. Any number of API instances can consume: BullMQ hands each job to one of them.
 */
@Injectable()
export class QueueConsumers implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(QueueConsumers.name);
  private workers: Worker[] = [];
  private connection: Redis | null = null;

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly processors: JobProcessors,
    private readonly deadLetter: DeadLetterService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.QUEUE_CONSUMERS) return;
    this.connection = new Redis(this.env.REDIS_URL, { maxRetriesPerRequest: null });
    for (const [queue, concurrency] of CONSUMERS) {
      const worker = new Worker<QueueJob>(queue, (job) => this.processors.process(job), {
        connection: this.connection,
        prefix: this.env.QUEUE_PREFIX,
        concurrency,
      });
      worker.on("failed", (job, err) => {
        if (!job) return;
        if (!isFinalFailure(job, err)) {
          this.logger.log(
            { queue, jobId: job.id, attempt: job.attemptsMade, error: err.message },
            "job will retry",
          );
          return;
        }
        void this.deadLetter
          .record(queue, job, err)
          .catch((e: unknown) =>
            this.logger.error({ err: e, queue, jobId: job.id }, "could not record failed job"),
          );
      });
      worker.on("error", (err) => this.logger.error({ err, queue }, "queue consumer error"));
      this.workers.push(worker);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    this.connection?.disconnect();
  }
}
