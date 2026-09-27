import { Inject, Injectable } from "@nestjs/common";
import type { ToolCall } from "@platform/core";
import type { EmailJob, QueueJob, ToolJob } from "@platform/shared";
import { deliverMail, type MailCredentials, type SmtpSettings, ToolError } from "@platform/tools";
import { type Job, UnrecoverableError } from "bullmq";
import { API_ENV, type ApiEnv } from "../../config/env";
import { TenantDbService } from "../../infra/tenant-db.service";
import { IntegrationsService } from "../integrations/integrations.service";
import { AgentConfigService } from "../telephony/agent-config.service";
import { ToolService } from "../tools/tool.service";
import { appendBackgroundEvent } from "./call-timeline";

/** Tool errors worth another attempt later; anything else needs a person (credentials, settings, input) */
const TRANSIENT = new Set(["unavailable", "rate_limited", "timeout"]);

/**
 * What each call-side job does. Throwing retries the job with backoff; an UnrecoverableError
 * sends it straight to the failed-jobs list.
 */
@Injectable()
export class JobProcessors {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly tenantDb: TenantDbService,
    private readonly configs: AgentConfigService,
    private readonly tools: ToolService,
    private readonly integrations: IntegrationsService,
  ) {}

  /** Extra handlers registered by other modules (CRM sync) */
  private readonly handlers = new Map<string, (job: Job<QueueJob>) => Promise<unknown>>();

  register(kind: string, handler: (job: Job<QueueJob>) => Promise<unknown>): void {
    this.handlers.set(kind, handler);
  }

  async process(job: Job<QueueJob>): Promise<unknown> {
    const d = job.data;
    // A suspended business's queued work (webhooks, emails, replies, CRM) is dropped
    if ("tenantId" in d && d.tenantId && !(await this.active(d.tenantId)))
      return { skipped: "business suspended" };
    if (d.kind === "tool") return this.tool(job as Job<ToolJob>);
    if (d.kind === "email") return this.email(job as Job<EmailJob>);
    const handler = this.handlers.get(d.kind);
    if (!handler) throw new UnrecoverableError(`No handler for ${d.kind} jobs`);
    return handler(job);
  }

  private async active(tenantId: string): Promise<boolean> {
    const t = await this.tenantDb
      .db(tenantId)
      .tenant.findUnique({ where: { id: tenantId }, select: { status: true } });
    return t?.status === "ACTIVE";
  }

  /** A background tool from a call (webhook, email, sheet row), with the agent's published grants */
  private async tool(job: Job<ToolJob>) {
    const d = job.data;
    const { config } = await this.configs.published(d.tenantId, d.agentVersionId);
    const runner = this.tools.forCall({
      tenantId: d.tenantId,
      callId: d.callId,
      conversationId: d.conversationId ?? null,
      agentId: d.agentId,
      callerNumber: d.callerNumber,
      timezone: d.timezone,
      config,
    });
    const result = await runner.run(d.call as ToolCall, {
      now: new Date(),
      timezone: d.timezone,
      callerNumber: d.callerNumber,
      defaultCountryCode: d.callingCode ?? this.env.DEFAULT_COUNTRY_CODE,
    });
    const [run] = runner.drain();
    const transient = !result.ok && TRANSIENT.has(result.error);
    // Email may already have been delivered when a send times out: don't risk sending it twice
    const retry = transient && !(d.call.tool.startsWith("email.") && result.error === "timeout");
    const last = !retry || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const callId = d.callId;
    // Calls show background results on their timeline; chats show failures in the failed-jobs list
    if ((result.ok || last) && callId) {
      await this.tenantDb.tx(d.tenantId, (tx) =>
        appendBackgroundEvent(tx, {
          tenantId: d.tenantId,
          callId,
          type: "TOOL_CALL",
          payload: {
            phase: "executed",
            background: true,
            tool: d.call.tool,
            stepId: d.call.stepId,
            ok: result.ok,
            error: result.ok ? null : result.error,
            detail: run?.detail ?? null,
            attempts: job.attemptsMade + 1,
            integrationId: run?.integrationId ?? null,
          },
          ...(run ? { latencyMs: run.latencyMs } : {}),
        }),
      );
    }
    if (result.ok) return { ok: true };
    const message = `${result.error}${run?.detail ? `: ${run.detail}` : ""}`;
    if (retry) throw new Error(message);
    throw new UnrecoverableError(message);
  }

  /** Staff emails (missed transfers) through the tenant's email integration */
  private async email(job: Job<EmailJob>) {
    const d = job.data;
    const mail = await this.integrations.firstOfType(d.tenantId, "EMAIL_SMTP");
    if (!mail) throw new UnrecoverableError("No email integration is connected");
    try {
      const net = this.integrations.toolNetwork;
      return await deliverMail(
        mail.credentials as unknown as MailCredentials,
        mail.config as unknown as SmtpSettings,
        { to: d.to, subject: d.subject, text: d.text },
        {
          allowPrivateNetwork: this.env.ALLOW_PRIVATE_NETWORK_TOOLS,
          timeoutMs: 10_000,
          idempotencyKey: d.idempotencyKey,
          google: { fetch, timeoutMs: 10_000, ...(net.googleOAuth ? { oauthClient: net.googleOAuth } : {}) },
          microsoft: {
            fetch,
            timeoutMs: 10_000,
            ...(net.microsoftOAuth ? { oauthClient: net.microsoftOAuth } : {}),
            onRefreshToken: (t: string) =>
              this.integrations.saveRefreshToken(d.tenantId, mail.integrationId, t),
          },
        },
      );
    } catch (err) {
      if (err instanceof ToolError && (err.kind === "auth" || err.kind === "config"))
        await this.integrations.markError(d.tenantId, mail.integrationId, err.message);
      if (err instanceof ToolError && (err.kind === "unavailable" || err.kind === "rate_limited")) throw err;
      throw new UnrecoverableError((err as Error).message);
    }
  }
}
