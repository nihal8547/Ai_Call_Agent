import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { type PlatformMailJob, QUEUES } from "@platform/shared";
import { type Job, Worker } from "bullmq";
import nodemailer, { type Transporter } from "nodemailer";
import { API_ENV, type ApiEnv } from "../../config/env";
import { QueueService } from "../../infra/queue.service";

const ATTEMPTS = 4;
const FIRST_RETRY_MS = 10_000;

/**
 * The platform's own emails (invitations, password resets), through SMTP_URL. They go through the
 * `mail` queue so a slow or briefly unavailable mail server never delays a request, with retries.
 * Links in these emails are secrets: jobs are removed as soon as they finish, and failed ones
 * within an hour (the links themselves expire).
 */
@Injectable()
export class PlatformMailService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PlatformMailService.name);
  private transport: Transporter | null = null;
  private worker: Worker | null = null;

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly queues: QueueService,
  ) {}

  /** Is the platform mail server configured? */
  get enabled(): boolean {
    return Boolean(this.env.SMTP_URL);
  }

  /** Queue an email; returns false (and sends nothing) when no mail server is configured */
  async enqueue(job: Omit<PlatformMailJob, "kind">): Promise<boolean> {
    if (!this.enabled) return false;
    await this.queues.queue<PlatformMailJob>(QUEUES.mail).add(
      job.purpose,
      { kind: "platform_mail", ...job },
      {
        attempts: ATTEMPTS,
        backoff: {
          type: "exponential",
          delay: Math.max(1, Math.round(FIRST_RETRY_MS * this.env.QUEUE_BACKOFF_SCALE)),
        },
        removeOnComplete: true,
        removeOnFail: { age: 3600 },
      },
    );
    return true;
  }

  /** Send now (the queue consumer calls this) */
  async send(job: PlatformMailJob): Promise<void> {
    this.transport ??= createPlatformTransport(this.env.SMTP_URL!);
    await this.transport.sendMail({
      from: this.env.MAIL_FROM,
      to: job.to,
      subject: job.subject,
      text: job.text,
      html: job.html,
    });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled || !this.env.QUEUE_CONSUMERS) return;
    this.worker = new Worker<PlatformMailJob>(QUEUES.mail, (job) => this.send(job.data), {
      connection: this.queues.connection,
      prefix: this.env.QUEUE_PREFIX,
      concurrency: 5,
    });
    this.worker.on("failed", (job: Job<PlatformMailJob> | undefined, err) => {
      // The recipient only, never the body: it holds the link
      this.logger.warn(
        { purpose: job?.data.purpose, to: job?.data.to, attempt: job?.attemptsMade, error: err.message },
        "platform email not sent",
      );
    });
    this.worker.on("error", (err) => this.logger.error({ err }, "mail queue consumer error"));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    this.transport?.close();
  }
}

/** smtp://user:pass@host:587 (STARTTLS required) or smtps://user:pass@host:465 (TLS) */
export function createPlatformTransport(smtpUrl: string): Transporter {
  const u = new URL(smtpUrl);
  const secure = u.protocol === "smtps:";
  // Plain SMTP is only accepted to a local mail catcher (development)
  const local = ["localhost", "127.0.0.1", "::1", "mailpit"].includes(u.hostname);
  return nodemailer.createTransport({
    host: u.hostname,
    port: Number(u.port || (secure ? 465 : 587)),
    secure,
    requireTLS: !secure && !local,
    ...(u.username
      ? { auth: { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } }
      : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}
