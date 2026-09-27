import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { createLLMProvider } from "@platform/ai";
import type { CallSession, EngineContext, ToolCall } from "@platform/core";
import type { ConversationMessage, Prisma, TenantTx } from "@platform/db";
import { createRuntime, type RuntimeEvent, type RuntimeTurn } from "@platform/runtime";
import {
  type AgentConfig,
  type QueueJob,
  queueForTool,
  systemLines,
  TOOL_SPECS,
  type ToolName,
  WhatsAppNumberSettings,
  type WhatsAppReplyJob,
} from "@platform/shared";
import { type Job } from "bullmq";
import { randomUUID } from "node:crypto";
import { API_ENV, type ApiEnv } from "../../config/env";
import { QueueService } from "../../infra/queue.service";
import { RedisService } from "../../infra/redis.service";
import { TenantDbService } from "../../infra/tenant-db.service";
import { MetricsService } from "../../observability/metrics.service";
import { CrmSyncService } from "../crm/crm-sync.service";
import { JobProcessors } from "../jobs/job-processors.service";
import { RetrieverFactory } from "../knowledge/retriever.factory";
import { AgentConfigService } from "../telephony/agent-config.service";
import { upsertLeadForCall } from "../telephony/lead-writer";
import { isBlocked, TenantSettingsService } from "../telephony/tenant-settings.service";
import { ToolService } from "../tools/tool.service";
import { turnUsage, UsageService } from "../usage/usage.service";
import { WhatsAppAccountsService } from "./whatsapp-accounts.service";
import { VOICE_MIME, WhatsAppMediaService } from "./whatsapp-media.service";
import { previewOf, type StoredInbound } from "./whatsapp-inbound.service";

const LOCK_MS = 60_000;
const LOCK_WAIT_MS = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
/** More customer messages than this in 10 minutes get no automatic reply (floods, loops with bots) */
const RATE_LIMIT = 30;

type Input =
  | { kind: "text"; text: string }
  /** A voice note that couldn't be transcribed (no speech service, or it failed) */
  | { kind: "voice" }
  /** A voice note too long to transcribe */
  | { kind: "voice_too_long" }
  /** Photos, files, stickers without any words */
  | { kind: "media" }
  /** Reactions: nothing to answer */
  | { kind: "ignore" };

/** What the customer said, from all messages since the agent last answered */
export function customerInput(
  messages: Pick<ConversationMessage, "type" | "text" | "transcript" | "mediaFilename" | "meta">[],
): Input {
  const parts: string[] = [];
  let voice = false;
  let tooLong = false;
  let media = false;
  for (const m of messages) {
    const text = m.text?.trim();
    switch (m.type) {
      case "TEXT":
      case "INTERACTIVE":
      case "LOCATION":
      case "CONTACTS":
        if (text) parts.push(text);
        break;
      case "AUDIO":
        if (m.transcript?.trim()) parts.push(m.transcript.trim());
        else if ((m.meta as { tooLong?: boolean } | null)?.tooLong) tooLong = true;
        else voice = true;
        break;
      case "IMAGE":
      case "VIDEO":
      case "DOCUMENT":
        if (text) parts.push(text);
        else media = true;
        break;
      case "STICKER":
        media = true;
        break;
      default:
        break; // reactions, unsupported
    }
  }
  if (parts.length) return { kind: "text", text: parts.join("\n").slice(0, 2000) };
  if (tooLong) return { kind: "voice_too_long" };
  if (voice) return { kind: "voice" };
  if (media) return { kind: "media" };
  return { kind: "ignore" };
}

/**
 * The agent answers WhatsApp conversations with the same runtime as calls (understanding,
 * knowledge answers, workflow, tools, guards), written instead of spoken. One conversation is
 * answered at a time; messages that arrive together are answered together.
 */
@Injectable()
export class WhatsAppAgentService implements OnModuleInit {
  private readonly logger = new Logger(WhatsAppAgentService.name);

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly tenantDb: TenantDbService,
    private readonly queues: QueueService,
    private readonly redis: RedisService,
    private readonly processors: JobProcessors,
    private readonly configs: AgentConfigService,
    private readonly settings: TenantSettingsService,
    private readonly tools: ToolService,
    private readonly retrievers: RetrieverFactory,
    private readonly crm: CrmSyncService,
    private readonly usage: UsageService,
    private readonly accounts: WhatsAppAccountsService,
    private readonly media: WhatsAppMediaService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    this.processors.register("whatsapp_reply", (job: Job<QueueJob>) =>
      this.reply(job as Job<WhatsAppReplyJob>),
    );
  }

  /** New customer messages: the job waits until the customer pauses, so quick messages get one reply */
  async schedule(stored: StoredInbound[]): Promise<void> {
    for (const s of stored) {
      await this.queues.add(
        "whatsapp",
        {
          kind: "whatsapp_reply",
          tenantId: s.tenantId,
          conversationId: s.conversationId,
          label: "Answer a WhatsApp message",
        },
        `wa-reply-${s.messageId}`,
      );
    }
  }

  async reply(job: Job<WhatsAppReplyJob>): Promise<{ replied: boolean; reason?: string }> {
    const { tenantId, conversationId } = job.data;
    await this.untilQuiet(tenantId, conversationId);
    const redis = this.redis.client;
    const lockKey = `lock:wa-reply:${conversationId}`;
    const token = randomUUID();
    // One reply at a time per conversation: wait for the one in progress (it may answer ours too)
    const deadline = Date.now() + LOCK_WAIT_MS;
    while ((await redis.set(lockKey, token, "PX", LOCK_MS, "NX")) !== "OK") {
      if (Date.now() > deadline) throw new Error("conversation busy"); // BullMQ retries later
      await sleep(100);
    }
    try {
      return await this.answer(tenantId, conversationId);
    } finally {
      await redis.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
        1,
        lockKey,
        token,
      );
    }
  }

  /**
   * Customers often send several short messages in a row: wait until the latest one is
   * WHATSAPP_REPLY_DELAY_MS old (bounded), then answer them all at once.
   */
  private async untilQuiet(tenantId: string, conversationId: string): Promise<void> {
    const delay = this.env.WHATSAPP_REPLY_DELAY_MS;
    const giveUpAt = Date.now() + Math.max(delay * 4, 1000);
    while (Date.now() < giveUpAt) {
      const latest = await this.tenantDb.db(tenantId).conversationMessage.findFirst({
        where: { conversationId, direction: "INBOUND" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      const wait = latest ? latest.createdAt.getTime() + delay - Date.now() : 0;
      if (wait <= 0) return;
      await sleep(Math.min(wait, giveUpAt - Date.now()));
    }
  }

  private async answer(
    tenantId: string,
    conversationId: string,
  ): Promise<{ replied: boolean; reason?: string }> {
    const db = this.tenantDb.db(tenantId);
    const c = await db.conversation.findUnique({
      where: { id: conversationId },
      include: { whatsappNumber: { include: { agent: true } } },
    });
    if (!c) return { replied: false, reason: "conversation deleted" };
    let pending = await db.conversationMessage.findMany({
      where: {
        conversationId,
        direction: "INBOUND",
        ...(c.agentHandledAt ? { createdAt: { gt: c.agentHandledAt } } : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (!pending.length) return { replied: false, reason: "nothing new" };
    // Files first (download before Meta's link expires; voice notes transcribed for staff and the agent)
    if (c.whatsappNumber.status === "CONNECTED")
      pending = await this.media.prepareMedia(tenantId, c.whatsappNumber, pending, undefined);
    const cursor = pending[pending.length - 1]!.createdAt;
    const skip = async (reason: string) => {
      await db.conversation.update({ where: { id: c.id }, data: { agentHandledAt: cursor } });
      this.metrics.whatsappReplies.inc({ result: reason });
      return { replied: false, reason };
    };

    // Staff are replying, or it's closed: the agent stays quiet (the messages are still marked handled)
    if (c.mode !== "AI") return skip("staff");
    if (c.whatsappNumber.status !== "CONNECTED") return skip("disconnected");

    // The answering agent: pinned per conversation; picked up when the number's agent is published
    let agentId = c.agentId;
    let versionId = c.agentVersionId;
    if (!versionId) {
      const a = c.whatsappNumber.agent;
      if (!a || a.status !== "ACTIVE" || !a.publishedVersionId) return skip("no_agent");
      agentId = a.id;
      versionId = a.publishedVersionId;
    }
    const settings = await this.settings.get(tenantId);
    if (isBlocked(c.contactPhone, settings.blocked)) return skip("blocked");
    const count = await this.redis.client.incr(`wa-rate:${conversationId}`);
    if (count === 1) await this.redis.client.expire(`wa-rate:${conversationId}`, 600);
    if (count > RATE_LIMIT) return skip("rate_limited");

    const input = customerInput(pending);
    if (input.kind === "ignore") return skip("nothing_to_answer");

    const { config, timezone } = await this.configs.published(tenantId, versionId);
    const creds = await this.accounts.credentials(tenantId, c.whatsappNumber).catch(() => null);
    const lastWamid = pending[pending.length - 1]!.wamid;
    // Blue ticks and "typing…" while the agent thinks (best effort)
    if (creds && lastWamid)
      await this.accounts.graph
        .markRead(creds.accessToken, c.whatsappNumber.phoneNumberId, lastWamid, true)
        .catch(() => undefined);

    const lines = systemLines(config.language);
    const ctx: EngineContext = {
      now: new Date(),
      timezone: config.workingHours?.timezone ?? timezone,
      callerNumber: c.contactPhone,
      defaultCountryCode: settings.callingCode,
    };
    const toolRunner = this.tools.forCall({
      tenantId,
      callId: null,
      conversationId,
      agentId: agentId!,
      callerNumber: c.contactPhone,
      timezone: ctx.timezone,
      config,
    });
    const llm = createLLMProvider(config.llm.provider, { gemini: this.env.GEMINI_API_KEY });
    const runtime = createRuntime({
      llm,
      tools: toolRunner,
      retriever: this.retrievers.forAgent({ tenantId, agentId: agentId! }, config, llm),
      channel: "chat",
    });

    const turns: RuntimeTurn[] = [];
    let session = validSession(c.engineSession);
    let text: string;
    let control: "listen" | "transfer" | "hangup" = "listen";
    let backgroundTools: ToolCall[] = [];
    if (input.kind === "voice") text = lines.chatVoiceUnsupported;
    else if (input.kind === "voice_too_long") text = lines.chatVoiceTooLong;
    else if (input.kind === "media") text = lines.chatMediaOnly;
    else {
      // First message: the greeting (not its question: the customer already said what they want)
      let greeting = "";
      if (!session) {
        const start = await runtime.start(config, ctx, conversationId);
        turns.push(start);
        // The customer only sees the greeting (and "I'm an AI assistant"), not the first question: their message isn't an answer to it
        session = { ...start.output.session, awaiting: null };
        greeting = start.output.segments
          .filter((s) => s.kind === "greeting" || s.kind === "disclosure")
          .map((s) => s.text)
          .join(" ");
      }
      const turn = await runtime.turn(config, session, { transcript: input.text }, ctx);
      turns.push(turn);
      session = turn.output.session;
      backgroundTools = turn.output.backgroundTools;
      control =
        turn.output.control === "transfer"
          ? "transfer"
          : turn.output.control === "hangup"
            ? "hangup"
            : "listen";
      // On WhatsApp a "transfer" is a hand-over to staff in the Inbox, not a phone transfer
      const said = control === "transfer" ? lines.chatHandoff : turn.speech;
      text = [greeting, said].filter(Boolean).join("\n\n");
    }

    const last = turns.at(-1);
    const sources = retrievalSources(last);
    const executed = toolRunner.drain().map((e) => ({ tool: e.tool, ok: e.ok, error: e.error ?? null }));
    const collected = session?.collected ?? {};

    // A voice note is answered with a voice note (the number's setting), when it suits speaking
    const numberSettings = WhatsAppNumberSettings.parse(c.whatsappNumber.settings ?? {});
    const toVoice = input.kind === "text" && pending.some((m) => m.type === "AUDIO" && m.transcript);
    const replyId = randomUUID();
    const spoken =
      toVoice && numberSettings.voiceReplies !== "text" && this.media.canSpeak(text)
        ? await this.media.speak(tenantId, conversationId, replyId, text, numberSettings.voice)
        : null;
    const alsoText = Boolean(spoken) && numberSettings.voiceReplies === "both";

    const { messageIds, leadId } = await this.tenantDb.tx(tenantId, async (tx) => {
      const meta = {
        sources,
        tools: executed,
        deterministic: last ? last.metrics.deterministic : true,
        latencyMs: turns.reduce((n, t) => n + t.metrics.totalMs, 0),
        ...(control !== "listen" ? { control } : {}),
        ...(toVoice && !spoken
          ? { voiceFallback: numberSettings.voiceReplies === "text" ? "setting" : "text_only" }
          : {}),
      } as Prisma.InputJsonObject;
      const m = await tx.conversationMessage.create({
        data: {
          id: replyId,
          tenantId,
          conversationId,
          direction: "OUTBOUND",
          sender: "AI",
          type: spoken ? "AUDIO" : "TEXT",
          // The words are kept with a voice reply, for staff and the lead history
          text: text.slice(0, 4096),
          ...(spoken ? { mediaKey: spoken.key, mediaMime: VOICE_MIME, mediaSeconds: spoken.seconds } : {}),
          status: "QUEUED",
          meta,
        },
      });
      const ids = [m.id];
      if (alsoText) {
        const t = await tx.conversationMessage.create({
          data: {
            tenantId,
            conversationId,
            direction: "OUTBOUND",
            sender: "AI",
            type: "TEXT",
            text: text.slice(0, 4096),
            status: "QUEUED",
          },
        });
        ids.push(t.id);
      }
      if (control === "transfer") await note(tx, tenantId, conversationId, handoffNote(session, config));
      if (control === "hangup") await note(tx, tenantId, conversationId, "The agent ended the conversation");
      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          agentId,
          agentVersionId: versionId,
          agentHandledAt: cursor,
          lastMessageAt: new Date(),
          lastMessagePreview: previewOf({
            type: alsoText || !spoken ? "TEXT" : "AUDIO",
            text: spoken && !alsoText ? null : text,
          }),
          ...(session ? { engineSession: session as unknown as Prisma.InputJsonObject } : {}),
          ...(control === "transfer" ? { mode: "HUMAN" as const } : {}),
          ...(control === "hangup" ? { mode: "CLOSED" as const, closedAt: new Date() } : {}),
        },
      });
      const lead = Object.keys(collected).length
        ? await upsertLeadForCall(tx, {
            tenantId,
            callId: null,
            conversationId,
            agentId: agentId!,
            callerNumber: c.contactPhone,
            collected,
            config,
          })
        : null;
      await this.usage.record(tx, tenantId, null, [
        ...turns.flatMap((t) => turnUsage(t, { callerSpoke: false, spoken: false })),
        { kind: "WHATSAPP_MESSAGES", quantity: ids.length, provider: "meta", model: null },
        ...(spoken
          ? [
              {
                kind: "TTS_CHARACTERS" as const,
                quantity: text.length,
                provider: "gemini",
                model: spoken.model,
              },
            ]
          : []),
      ]);
      return { messageIds: ids, leadId: lead?.id ?? null };
    });

    // After commit: send, run background tools, sync the lead, tell staff about a hand-over
    for (const messageId of messageIds)
      await this.queues.add(
        "whatsapp",
        { kind: "whatsapp_send", tenantId, messageId, label: `Send the agent's reply to ${c.contactPhone}` },
        `wa-send-${messageId}`,
      );
    for (const call of backgroundTools) {
      await this.queues.add(
        queueForTool(call.tool),
        {
          kind: "tool",
          tenantId,
          label: `${TOOL_SPECS[call.tool as ToolName]?.label ?? call.tool} for the WhatsApp chat with ${c.contactPhone}`,
          callId: null,
          conversationId,
          agentId: agentId!,
          agentVersionId: versionId,
          callerNumber: c.contactPhone,
          timezone: ctx.timezone,
          callingCode: settings.callingCode,
          call,
        },
        `tool-${conversationId}-${call.idempotencyKey}`,
      );
    }
    if (leadId) await this.crm.enqueueLead(tenantId, leadId);
    if (control === "transfer") await this.notifyStaff(tenantId, c, config, session);
    this.metrics.whatsappReplies.inc({
      result: control === "listen" ? (spoken ? "voice_reply" : input.kind) : control,
    });
    return { replied: true };
  }

  /** Staff hear that a customer wants a person, by email (notifications queue, with retries) */
  private async notifyStaff(
    tenantId: string,
    c: { id: string; contactName: string | null; contactPhone: string },
    config: AgentConfig,
    session: CallSession | null,
  ): Promise<void> {
    if (!config.handoff.notifyEmails.length) return;
    const tenant = await this.tenantDb
      .db(tenantId)
      .tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
    const who = c.contactName ? `${c.contactName} (${c.contactPhone})` : c.contactPhone;
    await this.queues.add(
      "notifications",
      {
        kind: "email",
        tenantId,
        label: `WhatsApp hand-over email about ${c.contactPhone}`,
        to: config.handoff.notifyEmails,
        subject: `WhatsApp: ${who} would like to talk to someone`,
        text: [
          `A customer asked for a person on WhatsApp at ${config.businessName}. The agent has stopped replying in this conversation.`,
          "",
          handoffNote(session, config),
          "",
          `Reply in the Inbox: ${this.env.WEB_BASE_URL}/t/${tenant?.slug ?? ""}/inbox?c=${c.id}`,
        ].join("\n"),
        idempotencyKey: `wa-handoff:${c.id}:${session?.turns ?? 0}`,
      },
      `wa-handoff-${c.id}-${session?.turns ?? 0}`,
    );
  }
}

/** Sessions saved by this version of the engine only (anything else starts fresh) */
function validSession(raw: unknown): CallSession | null {
  const s = raw as CallSession | null;
  return s && s.version === 1 && Array.isArray(s.history) ? s : null;
}

/** Knowledge the reply used (staff see it in the Inbox) */
function retrievalSources(turn: RuntimeTurn | undefined) {
  const r = turn?.runtimeEvents.find(
    (e): e is Extract<RuntimeEvent, { type: "retrieval" }> =>
      e.type === "retrieval" && Boolean(e.used?.length),
  );
  return (r?.used ?? []).map((s) => ({
    documentId: s.documentId,
    title: s.title,
    ...(s.page ? { page: s.page } : {}),
  }));
}

function handoffNote(session: CallSession | null, config: AgentConfig): string {
  const details = session
    ? config.qualificationFields
        .filter((f) => session.collected[f.key] !== undefined && session.collected[f.key] !== null)
        .map((f) => `${f.label}: ${String(session.collected[f.key])}`)
    : [];
  const reason = session?.handoff.reason ? ` (${session.handoff.reason})` : "";
  return `The customer asked for a person${reason}. The agent stopped replying.${details.length ? ` Details so far: ${details.join("; ")}.` : ""}`.slice(
    0,
    1000,
  );
}

async function note(tx: TenantTx, tenantId: string, conversationId: string, text: string) {
  await tx.conversationMessage.create({
    data: {
      tenantId,
      conversationId,
      direction: "INTERNAL",
      sender: "SYSTEM",
      type: "NOTE",
      text,
      status: "RECEIVED",
    },
  });
}
