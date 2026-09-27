import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { QueueJob, WhatsAppSendJob } from "@platform/shared";
import { WhatsAppError } from "@platform/whatsapp";
import { type Job, UnrecoverableError } from "bullmq";
import { TenantDbService } from "../../infra/tenant-db.service";
import { MetricsService } from "../../observability/metrics.service";
import { JobProcessors } from "../jobs/job-processors.service";
import { WhatsAppAccountsService } from "./whatsapp-accounts.service";
import { WhatsAppMediaService } from "./whatsapp-media.service";

/**
 * Sends queued messages to customers (`whatsapp` queue). Meta has no idempotency key, so a job
 * only sends a message that has no wamid yet; failures are shown on the message in the Inbox.
 */
@Injectable()
export class WhatsAppSenderService implements OnModuleInit {
  private readonly logger = new Logger(WhatsAppSenderService.name);

  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly accounts: WhatsAppAccountsService,
    private readonly media: WhatsAppMediaService,
    private readonly processors: JobProcessors,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    this.processors.register("whatsapp_send", (job: Job<QueueJob>) => this.send(job as Job<WhatsAppSendJob>));
  }

  async send(job: Job<WhatsAppSendJob>): Promise<{ wamid: string } | { skipped: string }> {
    const { tenantId, messageId } = job.data;
    const db = this.tenantDb.db(tenantId);
    const m = await db.conversationMessage.findUnique({
      where: { id: messageId },
      include: { conversation: { include: { whatsappNumber: true } } },
    });
    if (!m) return { skipped: "message deleted" };
    if (m.wamid || !["QUEUED", "FAILED"].includes(m.status)) return { skipped: "already sent" };
    const number = m.conversation.whatsappNumber;

    const fail = async (err: WhatsAppError | Error) => {
      const code = err instanceof WhatsAppError ? err.code : null;
      await db.conversationMessage.update({
        where: { id: m.id },
        data: { status: "FAILED", errorCode: code, errorTitle: err.message.slice(0, 300) },
      });
      this.metrics.whatsappSends.inc({ sender: m.sender, result: "failed" });
    };

    let token: string;
    try {
      token = (await this.accounts.credentials(tenantId, number)).accessToken;
    } catch (err) {
      await fail(err as Error);
      throw new UnrecoverableError("The WhatsApp number is disconnected");
    }
    const to = m.conversation.contactWaId;
    const sendText = () =>
      this.accounts.graph.sendText(token, number.phoneNumberId, to, m.text ?? "", {
        replyTo: m.replyToWamid,
      });
    try {
      let wamid: string;
      let sentAsText = false;
      if (m.type === "AUDIO" && m.mediaKey) {
        try {
          wamid = (await this.media.sendVoice(token, number.phoneNumberId, to, m.mediaKey)).wamid;
        } catch (err) {
          // Meta refused the voice note (format, size): the words still reach the customer
          if (
            !(err instanceof WhatsAppError) ||
            err.retryable ||
            err.kind === "auth" ||
            err.kind === "window_closed" ||
            !m.text
          )
            throw err;
          this.logger.warn({ tenantId, messageId, err: err.message }, "voice reply refused; sent as text");
          wamid = (await sendText()).wamid;
          sentAsText = true;
        }
      } else if (m.type === "TEMPLATE") {
        const t = (
          m.meta as { template?: { name: string; language: string; header?: string[]; body?: string[] } }
        ).template;
        if (!t) throw new WhatsAppError("invalid", "The template details are missing");
        wamid = (
          await this.accounts.graph.sendTemplate(token, number.phoneNumberId, to, t.name, t.language, {
            header: t.header ?? [],
            body: t.body ?? [],
          })
        ).wamid;
      } else if (["IMAGE", "VIDEO", "DOCUMENT"].includes(m.type) && m.mediaKey) {
        wamid = (await this.media.sendFile(token, number.phoneNumberId, to, m)).wamid;
      } else {
        wamid = (await sendText()).wamid;
      }
      await db.conversationMessage.update({
        where: { id: m.id },
        data: {
          wamid,
          status: "SENT",
          sentAt: new Date(),
          errorCode: null,
          errorTitle: null,
          ...(sentAsText ? { meta: { ...(m.meta as object), sentAsText: true } } : {}),
        },
      });
      this.metrics.whatsappSends.inc({ sender: m.sender, result: "sent" });
      return { wamid };
    } catch (err) {
      if (!(err instanceof WhatsAppError)) throw err;
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (err.retryable && !lastAttempt) throw err; // BullMQ retries with backoff
      await fail(err);
      if (err.kind === "auth")
        await this.accounts.markTokenProblem(
          tenantId,
          number.id,
          "Meta rejected the access token. Reconnect this number in Settings → WhatsApp.",
        );
      this.logger.warn({ tenantId, messageId, kind: err.kind, code: err.code }, "WhatsApp message not sent");
      throw new UnrecoverableError(`WhatsApp: ${err.message}`);
    }
  }
}
