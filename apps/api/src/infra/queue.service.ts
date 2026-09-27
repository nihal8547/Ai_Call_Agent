import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import {
  type AnalyticsJob,
  type IngestionJob,
  QUEUE_RETRY,
  QUEUES,
  type QueueJob,
  type QueueName,
} from "@platform/shared";
import { type JobsOptions, Queue } from "bullmq";
import { Redis } from "ioredis";
import { API_ENV, type ApiEnv } from "../config/env";

type RetryQueue = keyof typeof QUEUE_RETRY;

/** Producer side of the background queues */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private _connection: Redis | null = null;
  private readonly queues = new Map<QueueName, Queue>();

  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {}

  /** Shared by producers and the in-process consumers */
  get connection(): Redis {
    this._connection ??= new Redis(this.env.REDIS_URL, { maxRetriesPerRequest: null });
    return this._connection;
  }

  get prefix(): string {
    return this.env.QUEUE_PREFIX;
  }

  queue<T = unknown>(name: QueueName): Queue<T> {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection, prefix: this.env.QUEUE_PREFIX });
      this.queues.set(name, q);
    }
    return q as Queue<T>;
  }

  get ingestion(): Queue<IngestionJob> {
    return this.queue<IngestionJob>(QUEUES.ingestion);
  }

  /** Retries with exponential backoff; finished jobs are kept a day, failed ones a week */
  retryOptions(queue: RetryQueue): JobsOptions {
    const { attempts, delayMs } = QUEUE_RETRY[queue];
    return {
      attempts,
      backoff: {
        type: "exponential",
        delay: Math.max(1, Math.round(delayMs * this.env.QUEUE_BACKOFF_SCALE)),
      },
      removeOnComplete: { age: 24 * 3600, count: 5000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    };
  }

  /**
   * Add a tenant job. The job id makes it idempotent: adding the same id again while the job is
   * waiting or kept is a no-op.
   */
  async add(
    queue: "webhooks" | "notifications" | "crm" | "whatsapp",
    job: QueueJob,
    jobId: string,
    delayMs = 0,
  ): Promise<void> {
    await this.queue(queue).add(job.kind, job, {
      ...this.retryOptions(queue),
      jobId: safeJobId(jobId),
      ...(delayMs ? { delay: delayMs } : {}),
    });
  }

  async addAnalytics(job: AnalyticsJob, jobId: string, delayMs = 0): Promise<void> {
    await this.queue(QUEUES.analytics).add(job.kind, job, {
      ...this.retryOptions("analytics"),
      jobId: safeJobId(jobId),
      removeOnComplete: true,
      ...(delayMs ? { delay: delayMs } : {}),
    });
  }

  /** Idempotent per document version: re-adding the same job id is a no-op while it is pending */
  async enqueueIngestion(job: IngestionJob, attemptKey: string): Promise<void> {
    await this.ingestion.add("ingest", job, {
      jobId: `${job.documentId}-${attemptKey}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this._connection?.disconnect();
  }
}

/** BullMQ job ids may not contain ":" (it separates key parts) or be purely numeric */
export function safeJobId(id: string): string {
  return `j-${id.replace(/[^\w.-]+/g, "_")}`.slice(0, 200);
}
