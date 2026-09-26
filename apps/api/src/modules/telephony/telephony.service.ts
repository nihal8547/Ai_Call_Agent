import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { createLLMProvider } from "@platform/ai";
import { type EngineContext, endCall, type ToolCall } from "@platform/core";
import { resolvePhoneNumber } from "@platform/db";
import { createRuntime, type RuntimeTurn } from "@platform/runtime";
import type { AgentConfig } from "@platform/shared";
import { type InboundCall, TwilioAdapter, type VoiceReply } from "@platform/telephony";
import { AppException } from "../../common/filters/problem-details.filter";
import { API_ENV, type ApiEnv } from "../../config/env";
import { PrismaService } from "../../infra/prisma.service";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AgentConfigService } from "./agent-config.service";
import { CallRecorder, timelineEvents } from "./call-recorder";
import { type CallState, CallStateStore } from "./call-state.store";
import { InternalTools } from "./internal-tools";

type CallContext = Pick<CallState, "tenantId" | "callId" | "agentId" | "callerNumber" | "timezone">;

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

    const route = await resolvePhoneNumber(this.prisma.client, call.to);
    if (!route?.agentId || !route.agentVersionId) {
      this.logger.warn({ to: call.to }, "inbound call to a number without an active agent");
      return this.render({ say: NOT_IN_SERVICE, hangup: true });
    }
    const { config, timezone } = await this.configs.published(route.tenantId, route.agentVersionId);
    const record = await this.tenantDb.db(route.tenantId).call.create({
      data: {
        tenantId: route.tenantId,
        agentId: route.agentId,
        agentVersionId: route.agentVersionId,
        providerCallSid: call.callSid,
        fromNumber: call.from.slice(0, 20),
        toNumber: call.to.slice(0, 20),
        status: "IN_PROGRESS",
        answeredAt: new Date(),
      },
    });

    const base = {
      callSid: call.callSid,
      tenantId: route.tenantId,
      callId: record.id,
      agentId: route.agentId,
      agentVersionId: route.agentVersionId,
      timezone: config.workingHours?.timezone ?? timezone,
      callerNumber: call.from,
    };
    const turn = await this.runtimeFor(base, config).start(config, this.ctx(base), record.id);
    const state: CallState = {
      ...base,
      session: turn.output.session,
      seq: 1,
      lastReply: "",
      eventSeq: 0,
      finalized: false,
    };
    const rows = [
      {
        type: "CALL_STARTED" as const,
        payload: { from: call.from, to: call.to, agentVersionId: route.agentVersionId },
      },
      ...timelineEvents(turn),
    ];
    return this.complete(state, config, turn, rows);
  }

  /** The caller said something (or stayed silent) */
  async turn(call: InboundCall, seq: number): Promise<string> {
    const result = await this.store.withLock(call.callSid, async () => {
      const state = await this.store.get(call.callSid);
      if (!state) return this.render({ say: LOST_CALL, hangup: true });
      if (seq !== state.seq || state.finalized) return state.lastReply; // retry or stale request
      const { config } = await this.configs.published(state.tenantId, state.agentVersionId);
      const speech = call.speech ?? { transcript: "" };
      const turn = await this.runtimeFor(state, config).turn(config, state.session, speech, this.ctx(state));
      return this.complete(state, config, turn, timelineEvents(turn, speech));
    });
    // Another instance is still working on this call's previous request
    return (
      result ??
      (await this.store.get(call.callSid))?.lastReply ??
      this.render({ say: LOST_CALL, hangup: true })
    );
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
        const out = endCall(state.session, config, this.ctx(state), "caller_hung_up");
        const turn: RuntimeTurn = {
          output: out,
          speech: "",
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
        state.eventSeq = await this.recorder.recordTurn(state, turn, timelineEvents(turn));
        await this.recorder.finalize(state, out.session, config);
      }
      await this.recorder.markStatus(state, status, call.durationSeconds);
      await this.store.delete(call.callSid);
    });
  }

  private async complete(
    state: CallState,
    config: AgentConfig,
    turn: RuntimeTurn,
    rows: ReturnType<typeof timelineEvents>,
  ): Promise<string> {
    const out = turn.output;
    state.session = out.session;
    state.eventSeq = await this.recorder.recordTurn(state, turn, rows);

    let reply: VoiceReply | { say: string; hangup: true };
    if (out.control === "transfer" && out.transferTo) {
      reply = {
        say: turn.speech,
        transfer: {
          to: out.transferTo,
          statusCallback: `${this.env.PUBLIC_BASE_URL}/telephony/twilio/dial-status`,
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
    if (out.control !== "listen") {
      await this.recorder.finalize(state, out.session, config);
      state.finalized = true;
    }
    this.runBackground(state, config, out.backgroundTools);

    state.seq += 1;
    state.lastReply = this.render(reply, config);
    await this.store.set(state.callSid, state);
    return state.lastReply;
  }

  private render(
    reply: Omit<VoiceReply, "voice" | "language"> & Partial<VoiceReply>,
    config?: AgentConfig,
  ): string {
    return this.adapter().render({
      voice: config?.voice.voice ?? "Polly.Kajal-Neural",
      language: config?.language ?? "en-IN",
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

  private runtimeFor(state: CallContext, config: AgentConfig) {
    const llm = createLLMProvider(config.llm.provider, { gemini: this.env.GEMINI_API_KEY });
    return createRuntime({ llm, tools: this.tools(state, config) });
  }

  private tools(state: CallContext, config: AgentConfig): InternalTools {
    return new InternalTools(this.tenantDb, { ...state, config });
  }

  /** Non-blocking tools (exports, notifications) run after the reply; they move to BullMQ in P11 */
  private runBackground(state: CallState, config: AgentConfig, calls: ToolCall[]): void {
    for (const call of calls) {
      void this.tools(state, config)
        .run(call, this.ctx(state))
        .then((r) => {
          if (!r.ok)
            this.logger.warn(
              { callId: state.callId, tool: call.tool, error: r.error },
              "background tool failed",
            );
        });
    }
  }

  private ctx(state: CallContext): EngineContext {
    return {
      now: new Date(),
      timezone: state.timezone,
      callerNumber: state.callerNumber,
      defaultCountryCode: this.env.DEFAULT_COUNTRY_CODE,
    };
  }
}
