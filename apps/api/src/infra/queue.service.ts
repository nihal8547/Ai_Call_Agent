import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { type IngestionJob, QUEUES } from "@platform/shared";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { API_ENV, type ApiEnv } from "../config/env";

/** Producer side of the background queues */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private connection: Redis | null = null;
  private ingestionQueue: Queue<IngestionJob> | null = null;

  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {}

  get ingestion(): Queue<IngestionJob> {
    this.connection ??= new Redis(this.env.REDIS_URL, { maxRetriesPerRequest: null });
    this.ingestionQueue ??= new Queue<IngestionJob>(QUEUES.ingestion, {
      connection: this.connection,
      prefix: this.env.QUEUE_PREFIX,
    });
    return this.ingestionQueue;
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
    await this.ingestionQueue?.close();
    this.connection?.disconnect();
  }
}
