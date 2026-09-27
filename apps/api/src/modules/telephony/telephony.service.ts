import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { createLLMProvider } from "@platform/ai";
import { type EngineContext, endCall, parsePhone, renderTemplate, type ToolCall } from "@platform/core";
import { createRuntime, type RuntimeTurn } from "@platform/runtime";
import type { AgentConfig } from "@platform/shared";
import {
  type InboundCall,
  relayTranscriber,
  relayTts,
  renderConversationRelay,
  TwilioAdapter,
  type VoiceReply,
} from "@platform/telephony";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { AppException } from "../../common/filters/problem-details.filter";
import { API_ENV, type ApiEnv } from "../../config/env";
import { PrismaService } from "../../infra/prisma.service";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AgentConfigService } from "./agent-config.service";
import { CallRecorder, timelineEvents } from "./call-recorder";
import { type CallState, CallStateStore } from "./call-state.store";
import { queueForTool, systemLines, TOOL_SPECS, type ToolName, voiceForLanguage } from "@platform/shared";
import type { ToolRunEvent } from "@platform/tools";
import { QueueService } from "../../infra/queue.service";
import { CrmSyncService } from "../crm/crm-sync.service";
import { CallGate } from "./call-gate";
import { type CallRoute, CallRouter } from "./call-router";
import { TenantSettingsService } from "./tenant-settings.service";
import { MetricsService } from "../../observability/metrics.service";
import { RetrieverFactory } from "../knowledge/retriever.factory";
import { type CallTools, ToolService } from "../tools/tool.service";
import { upsertLeadForCall } from "./lead-writer";

type CallContext = Pick<CallState, "tenantId" | "callId" | "agentId" | "callerNumber" | "timezone">;

/** What the caller said, and how */
type CallerInput = { transcript: string; confidence?: number; bargeIn?: boolean; keypad?: boolean };

/** What a streaming session does after a turn */
export type RelayOutcome =
  | { kind: "say"; text: string }
  /** The agent ended the session (transfer or goodbye): Twilio fetches the final TwiML */
  | { kind: "end"; reason: string }
  /** The call is gone or another instance holds it */
  | { kind: "gone" };

export const RELAY_PATH = "/telephony/twilio/relay";

const NOT_IN_SERVICE = "Sorry, this number is not in service right now. Please try again later. Goodbye.";
const LOST_CALL = "Sorry, we had a problem on our side. Please call us back. Goodbye.";

const PROVIDER_STATUS: Record<string, "COMPLETED" | "FAILED" | "NO_ANSWER" | "BUSY" | "CANCELED"> = {
  completed: "COMPLETED",
  failed: "FAILED",
  "no-answer": "NO_ANSWER",
  busy: "BUSY",
  canceled: "CANCELED",
};

@Injectable()
export class TelephonyService {
  private readonly logger = new Logger(TelephonyService.name);
  readonly twilio: TwilioAdapter | null;

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDbService,
    private readonly configs: AgentConfigService,
    private readonly store: CallStateStore,
    private readonly recorder: CallRecorder,
    private readonly toolService: ToolService,
    private readonly queues: QueueService,
    private readonly crm: CrmSyncService,
    private readonly retrievers: RetrieverFactory,
    private readonly router: CallRouter,
    private readonly gate: CallGate,
    private readonly settings: TenantSettingsService,
    private readonly metrics: MetricsService,
  ) {
    this.twilio = env.TWILIO_AUTH_TOKEN ? new TwilioAdapter(env.TWILIO_AUTH_TOKEN) : null;
  }

  adapter(): TwilioAdapter {
    if (!this.twilio)
      throw new AppException(
        HttpStatus.SERVICE_UNAVAILABLE,
        "SERVICE_UNAVAILABLE",
        "Telephony is not configured",
      );
    return this.twilio;
  }

  /** A new call arrives */
  async inbound(call: InboundCall): Promise<string> {
    const existing = await this.store.get(call.callSid);
    if (existing) return existing.lastReply; // provider retry of the first webhook

    const route = await this.router.route(call, async (t) => (await this.settings.get(t)).callingCode);
    if (!route) {
      this.metrics.calls.inc({
        connection: call.to.startsWith("sip:") ? "SIP" : "TWILIO",
        result: "unknown_number",
      });
      this.logger.warn({ to: call.to }, "inbound call to an unknown number or SIP domain");
      return this.render({ say: NOT_IN_SERVICE, hangup: true });
    }
    // "Test forwarding": the staff member's test call proves the line reaches the agent
    const pending = route.verificationPending;
    if (pending && (!pending.from || pending.from === route.callerNumber)) {
      this.metrics.calls.inc({ connection: route.connection, result: "verification" });
      return this.verified(route, call);
    }

    const settings = await this.settings.get(route.tenantId);
    const gate = await this.gate.check(route, call.callSid, settings);
    if (!gate.ok) {
      this.metrics.calls.inc({ connection: route.connection, result: `refused_${gate.reason}` });
      this.logger.warn({ tenantId: route.tenantId, reason: gate.reason }, "call refused before answering");
      return gate.reject
        ? this.render({ say: "", reject: gate.reject })
        : this.render({ say: gate.say ?? NOT_IN_SERVICE, hangup: true });
    }
    if (!route.agentId || !route.agentVersionId) {
      await this.gate.release(route.phoneNumberId, call.callSid);
      this.logger.warn({ to: call.to }, "inbound call to a number without an active agent");
      return this.render({ say: NOT_IN_SERVICE, hangup: true });
    }
    this.metrics.calls.inc({ connection: route.connection, result: "answered" });
    void this.gate.watchVolume(route.tenantId);
    const { config, timezone } = await this.configs.published(route.tenantId, route.agentVersionId);
    const db = this.tenantDb.db(route.tenantId);
    const record = await db.call.create({
      data: {
        tenantId: route.tenantId,
        agentId: route.agentId,
        agentVersionId: route.agentVersionId,
        providerCallSid: call.callSid,
        fromNumber: route.callerNumber.slice(0, 20),
        toNumber: route.dialled.slice(0, 20),
        connection: route.connection,
        forwardedFrom: route.forwardedFrom?.slice(0, 20) ?? null,
        status: "IN_PROGRESS",
        answeredAt: new Date(),
      },
    });
    void db.phoneNumber
      .update({ where: { id: route.phoneNumberId }, data: { lastCallAt: new Date() } })
      .catch(() => undefined);

    const base = {
      callSid: call.callSid,
      tenantId: route.tenantId,
      callId: record.id,
      agentId: route.agentId,
      agentVersionId: route.agentVersionId,
      timezone: config.workingHours?.timezone ?? timezone,
      callerNumber: route.callerNumber,
      callingCode: settings.callingCode,
      phoneNumberId: route.phoneNumberId,
      businessNumber: route.businessNumber,
      startedAt: Date.now(),
      maxCallMinutes: settings.maxCallMinutes,
    };
    const tools = this.tools(base, config);
    const turn = await this.runtimeFor(base, config, tools).start(config, this.ctx(base), record.id);
    const state: CallState = {
      ...base,
      session: turn.output.session,
      seq: 1,
      lastReply: "",
      eventSeq: 0,
      finalized: false,
      // Streaming voice when the agent asks for it (and the operator hasn't switched it off)
      ...(this.env.VOICE_STREAMING && config.voice.mode === "streaming" && turn.output.control === "listen"
        ? { relay: { token: randomBytes(24).toString("base64url") } }
        : {}),
    };
    const rows = [
      {
        type: "CALL_STARTED" as const,
        payload: {
          from: route.callerNumber,
          to: route.dialled,
          via: route.connection,
          ...(route.forwardedFrom ? { forwardedFrom: route.forwardedFrom } : {}),
          agentVersionId: route.agentVersionId,
          mode: state.relay ? "streaming" : "classic",
        },
      },
      ...timelineEvents(turn),
      ...executionEvents(tools.drain()),
    ];
    return (await this.complete(state, config, turn, rows)).twiml;
  }

  /** The caller said something (or stayed silent) */
  async turn(call: InboundCall, seq: number): Promise<string> {
    const result = await this.store.withLock(call.callSid, async () => {
      const state = await this.store.get(call.callSid);
      if (!state) return this.render({ say: LOST_CALL, hangup: true });
      if (seq !== state.seq || state.finalized) return state.lastReply; // retry or stale request
      return (await this.advance(state, call.speech ?? { transcript: "" })).twiml;
    });
    // Another instance is still working on this call's previous request
    return (
      result ??
      (await this.store.get(call.callSid))?.lastReply ??
      this.render({ say: LOST_CALL, hangup: true })
    );
  }

  /** One caller turn through the runtime (both modes), or the end when the call is too long */
  private async advance(state: CallState, speech: CallerInput) {
    const { config } = await this.configs.published(state.tenantId, state.agentVersionId);
    if (
      state.startedAt &&
      state.maxCallMinutes &&
      Date.now() - state.startedAt > state.maxCallMinutes * 60_000
    ) {
      const end = this.systemEnd(state, config, "max_duration", systemLines(config.language).maxDuration);
      return this.complete(state, config, end, timelineEvents(end, speech));
    }
    const tools = this.tools(state, config);
    const turn = await this.runtimeFor(state, config, tools).turn(
      config,
      state.session,
      {
        transcript: speech.transcript,
        ...(speech.confidence !== undefined ? { confidence: speech.confidence } : {}),
      },
      this.ctx(state),
    );
    return this.complete(state, config, turn, [
      ...timelineEvents(turn, speech),
      ...executionEvents(tools.drain()),
    ]);
  }

  // ── Streaming voice (Twilio ConversationRelay) ─────────────────────────────

  /**
   * A streaming session opened for a call: it must name a live streaming call and carry that
   * call's one-time token. Returns what the session needs, or null to refuse it.
   */
  async relayConnect(
    callSid: string,
    token: string | undefined,
    sessionId: string,
  ): Promise<{ greeting: string; language: string; filler: string } | null> {
    const result = await this.store.withLock(callSid, async () => {
      const state = await this.store.get(callSid);
      const expected = state?.relay?.token;
      if (!state || !expected || !token || state.finalized || state.relay?.fellBack) return null;
      const a = Buffer.from(expected);
      const b = Buffer.from(token);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
      // One session per call (a second socket with the same token is refused)
      if (state.relay!.sessionId && state.relay!.sessionId !== sessionId) return null;
      state.relay!.sessionId = sessionId;
      await this.store.set(callSid, state);
      const { config } = await this.configs.published(state.tenantId, state.agentVersionId);
      return {
        greeting: state.lastSpeech ?? "",
        language: config.language,
        filler: systemLines(config.language).oneMoment,
      };
    });
    return result ?? null;
  }

  /** The caller finished speaking (or stayed silent) on a streaming call */
  async relayTurn(callSid: string, sessionId: string, speech: CallerInput): Promise<RelayOutcome> {
    const result = await this.store.withLock(
      callSid,
      async (): Promise<RelayOutcome> => {
        const state = await this.store.get(callSid);
        if (!state || state.relay?.sessionId !== sessionId || state.relay.fellBack) return { kind: "gone" };
        if (state.finalized) return { kind: "end", reason: "finished" };
        const done = await this.advance(state, speech);
        return done.control === "listen"
          ? { kind: "say", text: done.speech }
          : { kind: "end", reason: done.control };
      },
      15_000,
    );
    return result ?? { kind: "gone" };
  }

  /**
   * The streaming session ended and Twilio asks what next. After the agent's goodbye or transfer
   * that is the stored TwiML (its last words, then <Hangup/> or <Dial>); if the stream broke
   * mid-conversation, the call carries on turn by turn from the last question.
   */
  async relayEnded(call: InboundCall): Promise<string> {
    const result = await this.store.withLock(call.callSid, async () => {
      const state = await this.store.get(call.callSid);
      if (!state) return this.render({ say: "", hangup: true });
      if (state.finalized || !state.relay || state.relay.fellBack) return state.lastReply;
      state.relay.fellBack = true;
      this.metrics.relay.inc({ event: "fallback" });
      this.logger.warn({ callId: state.callId }, "streaming session ended mid-call; continuing turn by turn");
      await this.tenantDb.db(state.tenantId).callEvent.create({
        data: {
          tenantId: state.tenantId,
          callId: state.callId,
          seq: state.eventSeq++,
          type: "FALLBACK",
          payload: { reason: "streaming_ended" },
        },
      });
      state.lastReply = state.resume ?? this.render({ say: LOST_CALL, hangup: true });
      await this.store.set(state.callSid, state);
      return state.lastReply;
    });
    return result ?? this.render({ say: LOST_CALL, hangup: true });
  }

  /** wss:// address of the streaming endpoint, as Twilio is told to connect (and signs) */
  relayUrl(): string {
    return `${this.env.PUBLIC_BASE_URL.replace(/^http/, "ws")}${RELAY_PATH}`;
  }

  /** Final call status from the provider (also covers the caller hanging up mid-conversation) */
  async status(call: InboundCall): Promise<void> {
    await this.store.withLock(call.callSid, async () => {
      const state = await this.store.get(call.callSid);
      if (!state) return;
      const status = PROVIDER_STATUS[call.status];
      if (!status) return; // intermediate statuses (ringing, in-progress)
      if (!state.finalized) {
        const { config } = await this.configs.published(state.tenantId, state.agentVersionId);
        const turn = this.systemEnd(state, config, "caller_hung_up", "");
        state.eventSeq = await this.recorder.recordTurn(state, turn, timelineEvents(turn));
        await this.recorder.finalize(state, turn.output.session, config);
      }
      await this.recorder.markStatus(state, status, call.durationSeconds);
      await this.store.delete(call.callSid, state);
      if (state.phoneNumberId) await this.gate.release(state.phoneNumberId, call.callSid);
      await this.gate.clearTransfer(state.tenantId, state.callerNumber);
      // Refresh this business's analytics shortly (calls ending in the same minute share one job)
      const now = Date.now();
      await this.queues
        .addAnalytics(
          {
            kind: "rollup",
            tenantId: state.tenantId,
            from: new Date(now - 4 * 3_600_000).toISOString(),
            to: new Date(now + 1).toISOString(),
          },
          `rollup-${state.tenantId}-${Math.floor(now / 60_000)}`,
          Math.round(30_000 * this.env.QUEUE_BACKOFF_SCALE),
        )
        .catch((err: unknown) => this.logger.warn({ err }, "could not queue the analytics roll-up"));
    });
  }

  private async complete(
    state: CallState,
    config: AgentConfig,
    turn: RuntimeTurn,
    rows: ReturnType<typeof timelineEvents>,
  ): Promise<{ twiml: string; control: string; speech: string }> {
    const out = turn.output;
    state.session = out.session;
    state.eventSeq = await this.recorder.recordTurn(state, turn, rows);

    let reply: VoiceReply | { say: string; hangup: true };
    const toOwnLine =
      out.control === "transfer" &&
      out.transferTo &&
      state.businessNumber &&
      (parsePhone(out.transferTo, state.callingCode ?? this.env.DEFAULT_COUNTRY_CODE) ?? out.transferTo) ===
        state.businessNumber;
    if (toOwnLine) {
      // The business line forwards to this agent: dialling it would ring straight back here
      this.logger.warn({ callId: state.callId }, "transfer to the business's own forwarded line refused");
      state.missedTransfer = true;
      await this.recordMissedTransfer(state, config, "loop_protected");
      reply = {
        say: renderTemplate(
          config.handoff.unavailableMessage,
          config,
          out.session.collected,
          this.ctx(state),
        ),
        hangup: true,
      };
    } else if (out.control === "transfer" && out.transferTo) {
      await this.gate.markTransfer(state.tenantId, state.callerNumber);
      reply = {
        say: turn.speech,
        transfer: {
          to: out.transferTo,
          statusCallback: `${this.env.PUBLIC_BASE_URL}/telephony/twilio/dial-status`,
          // The staff member hears who is calling and why before being connected
          whisperUrl: `${this.env.PUBLIC_BASE_URL}/telephony/twilio/whisper?sid=${encodeURIComponent(state.callSid)}`,
        },
      } as VoiceReply;
    } else if (out.control === "listen") {
      reply = {
        say: turn.speech,
        listen: {
          action: `${this.env.PUBLIC_BASE_URL}/telephony/twilio/turn?seq=${state.seq + 1}`,
          hints: this.hints(config, out),
        },
      } as VoiceReply;
    } else {
      reply = { say: turn.speech, hangup: true };
    }
    if (out.control !== "listen" || toOwnLine) {
      await this.recorder.finalize(state, out.session, config);
      state.finalized = true;
    }
    await this.runBackground(state, out.backgroundTools);

    state.seq += 1;
    state.lastReply = this.render(reply, config);
    state.lastSpeech = turn.speech;
    if (state.relay && !state.relay.fellBack && out.control === "listen" && !toOwnLine) {
      // Streaming: the turn-by-turn TwiML is kept in case the stream breaks
      state.resume = state.lastReply;
      if (!state.relay.sessionId) {
        // The call's first reply: hand it to the streaming session, which speaks it as the greeting
        this.metrics.relay.inc({ event: "session" });
        state.lastReply = renderConversationRelay({
          url: this.relayUrl(),
          action: `${this.env.PUBLIC_BASE_URL}/telephony/twilio/relay-end`,
          greeting: turn.speech,
          language: config.language,
          tts: relayTts(voiceForLanguage(config.language, config.voice.voice)),
          transcriber: relayTranscriber(config.language, config.voice.transcriber),
          hints: this.hints(config, out),
          parameters: { token: state.relay.token },
        });
      }
    }
    await this.store.set(state.callSid, state);
    return { twiml: state.lastReply, control: toOwnLine ? "hangup" : out.control, speech: turn.speech };
  }

  private render(
    reply: Omit<VoiceReply, "voice" | "language"> & Partial<VoiceReply>,
    config?: AgentConfig,
  ): string {
    const language = config?.language ?? "en-IN";
    return this.adapter().render({
      // An Arabic agent left on an English voice would read Arabic badly: use a voice for its language
      voice: voiceForLanguage(language, config?.voice.voice),
      language,
      ...reply,
    } as VoiceReply).body;
  }

  /** Speech-recognition hints: the awaited field's options and hints first */
  private hints(config: AgentConfig, out: RuntimeTurn["output"]): string[] {
    const awaited = out.prompt?.fieldKey
      ? config.qualificationFields.find((f) => f.key === out.prompt!.fieldKey)
      : undefined;
    const rest = config.qualificationFields.filter((f) => f !== awaited);
    return [...new Set([awaited, ...rest].flatMap((f) => (f ? [...f.hints, ...f.options] : [])))];
  }

  /** Played to the staff member who answers a transfer, before the caller is connected */
  async whisper(callSid: string): Promise<string> {
    const state = await this.store.get(callSid);
    if (!state) return this.render({ say: "Incoming call transfer.", hangup: false });
    const { config } = await this.configs.published(state.tenantId, state.agentVersionId);
    return this.render({ say: transferSummary(state, config), hangup: false }, config);
  }

  /**
   * The transfer ended. If nobody answered, the caller hears the "team unavailable" message,
   * the call becomes a follow-up with a lead, and staff are emailed a summary.
   */
  async dialStatus(call: InboundCall): Promise<string> {
    const answered = call.dialStatus === "completed" || call.dialStatus === "answered";
    const result = await this.store.withLock(call.callSid, async () => {
      const state = await this.store.get(call.callSid);
      if (!state) return this.render({ say: "", hangup: true });
      await this.gate.clearTransfer(state.tenantId, state.callerNumber);
      const { config } = await this.configs.published(state.tenantId, state.agentVersionId);
      if (answered) return this.render({ say: "", hangup: true }, config);
      if (!state.missedTransfer) {
        state.missedTransfer = true;
        await this.recordMissedTransfer(state, config, call.dialStatus ?? "unknown");
        await this.store.set(state.callSid, state);
        await this.notifyStaff(state, config);
      }
      const say = renderTemplate(
        config.handoff.unavailableMessage,
        config,
        state.session.collected,
        this.ctx(state),
      );
      return this.render({ say, hangup: true }, config);
    });
    return result ?? this.render({ say: "", hangup: true });
  }

  private async recordMissedTransfer(
    state: CallState,
    config: AgentConfig,
    dialStatus: string,
  ): Promise<void> {
    const lead = await this.tenantDb.tx(state.tenantId, async (tx) => {
      await tx.callEvent.create({
        data: {
          tenantId: state.tenantId,
          callId: state.callId,
          seq: state.eventSeq++,
          type: "HANDOFF",
          payload: { transferred: false, dialStatus, reason: "no_answer" },
        },
      });
      await tx.call.update({ where: { id: state.callId }, data: { outcome: "FOLLOW_UP_REQUIRED" } });
      return upsertLeadForCall(tx, { ...state, collected: state.session.collected, config });
    });
    await this.crm.enqueueLead(state.tenantId, lead.id);
  }

  /** Staff hear about a missed transfer by email, sent (and retried) by the notifications queue */
  private async notifyStaff(state: CallState, config: AgentConfig): Promise<void> {
    if (!config.handoff.notifyEmails.length) return;
    const caller = state.callerNumber || "the caller";
    await this.queues.add(
      "notifications",
      {
        kind: "email",
        tenantId: state.tenantId,
        callId: state.callId,
        label: `Missed-transfer email about ${caller}`,
        to: config.handoff.notifyEmails,
        subject: `Missed transfer: please call back ${caller}`,
        text: [
          `A caller asked to speak to someone at ${config.businessName}, but the transfer was not answered.`,
          "",
          `Caller: ${state.callerNumber || "unknown number"}`,
          transferSummary(state, config),
          "",
          `Call reference: ${state.callId}`,
        ].join("\n"),
        idempotencyKey: `missed:${state.callId}`,
      },
      `missed-${state.callId}`,
    );
  }

  private runtimeFor(state: CallContext, config: AgentConfig, tools: CallTools) {
    const llm = createLLMProvider(config.llm.provider, { gemini: this.env.GEMINI_API_KEY });
    return createRuntime({ llm, tools, retriever: this.retrievers.forAgent(state, config, llm) });
  }

  private tools(state: CallContext, config: AgentConfig): CallTools {
    return this.toolService.forCall({ ...state, config });
  }

  /**
   * Non-blocking tools (webhooks, emails, sheet rows) are queued with the reply: they retry with
   * backoff and, if they still fail, show up in the tenant's failed-jobs list.
   */
  private async runBackground(state: CallState, calls: ToolCall[]): Promise<void> {
    for (const call of calls) {
      await this.queues.add(
        queueForTool(call.tool),
        {
          kind: "tool",
          tenantId: state.tenantId,
          label: `${TOOL_SPECS[call.tool as ToolName]?.label ?? call.tool} for the call from ${state.callerNumber || "an unknown number"}`,
          callId: state.callId,
          agentId: state.agentId,
          agentVersionId: state.agentVersionId,
          callerNumber: state.callerNumber,
          timezone: state.timezone,
          callingCode: state.callingCode ?? this.env.DEFAULT_COUNTRY_CODE,
          call,
        },
        `tool-${state.callId}-${call.idempotencyKey}`,
      );
    }
  }

  private ctx(state: CallContext & Pick<CallState, "callingCode">): EngineContext {
    return {
      now: new Date(),
      timezone: state.timezone,
      callerNumber: state.callerNumber,
      defaultCountryCode: state.callingCode ?? this.env.DEFAULT_COUNTRY_CODE,
    };
  }

  /** The platform ends the call (caller hung up, time limit), with the engine's bookkeeping */
  private systemEnd(state: CallState, config: AgentConfig, reason: string, speech: string): RuntimeTurn {
    const out = endCall(state.session, config, this.ctx(state), reason);
    return {
      output: out,
      speech,
      engineEvents: out.events,
      runtimeEvents: [],
      metrics: {
        totalMs: 0,
        understandMs: 0,
        retrieveMs: 0,
        decideMs: 0,
        toolMs: 0,
        phraseMs: 0,
        llmCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        deterministic: true,
      },
    };
  }

  /**
   * The test call for "Test forwarding" (or a SIP route) arrived: record what the carrier passed
   * and tell the staff member it works. Not a customer call, so no call record or agent.
   */
  private async verified(route: CallRoute, call: InboundCall): Promise<string> {
    const db = this.tenantDb.db(route.tenantId);
    const agent = route.agentId
      ? await db.agent.findUnique({ where: { id: route.agentId }, select: { name: true } })
      : null;
    const details = {
      from: route.callerNumber,
      forwardedFrom: route.forwardedFrom,
      via: route.connection,
      // Leads get the real caller only when the carrier keeps the caller's number when forwarding
      callerIdKept: Boolean(route.callerNumber) && route.callerNumber !== route.businessNumber,
      forwardedFromMatches: route.forwardedFrom ? route.forwardedFrom === route.businessNumber : null,
      callSid: call.callSid,
    };
    await db.phoneNumber.update({
      where: { id: route.phoneNumberId },
      data: {
        verificationStatus: "VERIFIED",
        verifiedAt: new Date(),
        verificationExpiresAt: null,
        verification: details,
        lastCallAt: new Date(),
      },
    });
    this.logger.log({ tenantId: route.tenantId, phoneNumberId: route.phoneNumberId }, "number verified");
    const who = agent ? `${agent.name}` : "your AI agent, once you choose one";
    return this.render({
      say: `Your number is connected. Calls will be answered by ${who}. You can hang up now.`,
      hangup: true,
    });
  }
}

/** Tool executions (after grant, binding and retries) on the call timeline */
function executionEvents(events: ToolRunEvent[]) {
  return events.map((e) => ({
    type: "TOOL_CALL" as const,
    payload: {
      phase: "executed",
      tool: e.tool,
      stepId: e.stepId,
      ok: e.ok,
      error: e.error ?? null,
      detail: e.detail ?? null,
      attempts: e.attempts,
      cached: e.cached,
      integrationId: e.integrationId,
    },
    latencyMs: e.latencyMs,
  }));
}

/** "Call from +91…. Priya, Service: Root canal, Urgency: Emergency." */
function transferSummary(state: Pick<CallState, "callerNumber" | "session">, config: AgentConfig): string {
  const parts = config.qualificationFields
    .filter((f) => state.session.collected[f.key] !== undefined && state.session.collected[f.key] !== null)
    .map((f) => `${f.label}: ${renderTemplate(`{{${f.key}}}`, config, state.session.collected)}`);
  const reason = state.session.handoff.reason ? ` Reason: ${state.session.handoff.reason}.` : "";
  const details = parts.length ? ` ${parts.join(". ")}.` : "";
  return `Transferred call from ${config.agentName}, the ${config.businessName} assistant.${reason}${details}`.slice(
    0,
    600,
  );
}
