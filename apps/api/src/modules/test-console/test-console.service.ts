import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { createLLMProvider } from "@platform/ai";
import type { CallSession, EngineContext, ToolCall } from "@platform/core";
import { readJson } from "@platform/db";
import { createRuntime, type RuntimeTurn } from "@platform/runtime";
import { turnUsage, UsageService } from "../usage/usage.service";
import { AgentConfig } from "@platform/shared";
import { randomUUID } from "node:crypto";
import type { AuthContext } from "../../common/auth/auth.types";
import { AppException } from "../../common/filters/problem-details.filter";
import { API_ENV, type ApiEnv } from "../../config/env";
import { RetrieverFactory } from "../knowledge/retriever.factory";
import { RedisService } from "../../infra/redis.service";
import { TenantDbService } from "../../infra/tenant-db.service";

type TestState = {
  tenantId: string;
  userId: string;
  agentId: string;
  versionId: string;
  version: number;
  config: AgentConfig;
  timezone: string;
  session: CallSession;
  /** Simulated clock: real elapsed time added to the chosen start moment */
  simulatedAt: string | null;
  startedAt: number;
  failTools: boolean;
};

const TTL_SECONDS = 30 * 60;

/**
 * Talk to any version (usually the draft) in text, with the exact runtime phone calls use.
 * Nothing is written to calls, leads or appointments: tools are simulated.
 */
@Injectable()
export class TestConsoleService {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly tenantDb: TenantDbService,
    private readonly redis: RedisService,
    private readonly retrievers: RetrieverFactory,
    private readonly usage: UsageService,
  ) {}

  /** Test calls use real AI: their tokens are metered too (no call, no telephony or speech) */
  private async meter(tenantId: string, turn: RuntimeTurn): Promise<void> {
    const lines = turnUsage(turn, { callerSpoke: false }).filter(
      (l) => l.kind !== "TTS_CHARACTERS" && l.kind !== "STT_SECONDS",
    );
    if (lines.length) await this.tenantDb.tx(tenantId, (tx) => this.usage.record(tx, tenantId, null, lines));
  }

  async start(
    auth: AuthContext,
    agentId: string,
    opts: { versionId?: string; simulatedAt?: Date; failTools: boolean },
  ) {
    const db = this.tenantDb.db(auth.tenantId);
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      include: { tenant: { select: { timezone: true } } },
    });
    if (!agent) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Agent not found");
    const version = opts.versionId
      ? await db.agentVersion.findFirst({ where: { id: opts.versionId, agentId } })
      : ((await db.agentVersion.findFirst({
          where: { agentId, status: "DRAFT" },
          orderBy: { version: "desc" },
        })) ??
        (agent.publishedVersionId
          ? await db.agentVersion.findUnique({ where: { id: agent.publishedVersionId } })
          : null));
    if (!version) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "No version to test");

    const parsed = AgentConfig.safeParse(version.config);
    if (!parsed.success)
      throw new AppException(HttpStatus.CONFLICT, "CONFLICT", "Save a valid draft before testing it");
    const config = parsed.data;
    const id = randomUUID();
    const base = {
      tenantId: auth.tenantId,
      userId: auth.kind === "user" ? auth.userId : auth.apiKeyId,
      agentId,
      versionId: version.id,
      version: version.version,
      config,
      timezone: config.workingHours?.timezone ?? agent.tenant.timezone,
      simulatedAt: opts.simulatedAt?.toISOString() ?? null,
      startedAt: Date.now(),
      failTools: opts.failTools,
    };
    const toolLog: ToolCall[] = [];
    const turn = await this.runtime(base, toolLog).start(config, this.ctx(base), `test-${id}`);
    await this.meter(auth.tenantId, turn);
    await this.save(id, { ...base, session: turn.output.session });
    return { sessionId: id, version: version.version, ...this.view(turn, toolLog) };
  }

  async message(auth: AuthContext, sessionId: string, text: string) {
    const state = await this.load(sessionId);
    const who = auth.kind === "user" ? auth.userId : auth.apiKeyId;
    if (!state || state.tenantId !== auth.tenantId || state.userId !== who) {
      throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Test session expired, start a new one");
    }
    if (state.session.ended)
      throw new AppException(HttpStatus.CONFLICT, "CONFLICT", "The test call has ended");
    const toolLog: ToolCall[] = [];
    const turn = await this.runtime(state, toolLog).turn(
      state.config,
      state.session,
      { transcript: text },
      this.ctx(state),
    );
    await this.meter(auth.tenantId, turn);
    await this.save(sessionId, { ...state, session: turn.output.session });
    return { sessionId, version: state.version, ...this.view(turn, toolLog) };
  }

  private runtime(state: Omit<TestState, "session">, toolLog: ToolCall[]) {
    const llm = createLLMProvider(state.config.llm.provider, { gemini: this.env.GEMINI_API_KEY });
    return createRuntime({
      llm,
      // Real knowledge answers (read-only), so the console shows what callers would hear
      retriever: this.retrievers.forAgent(state, state.config, llm),
      tools: {
        run: async (call) => {
          toolLog.push(call);
          return state.failTools
            ? { ok: false, error: "simulated_failure" }
            : { ok: true, data: { simulated: true } };
        },
      },
    });
  }

  private view(turn: RuntimeTurn, blockingTools: ToolCall[]) {
    const s = turn.output.session;
    return {
      reply: turn.speech,
      control: turn.output.control,
      transferTo: turn.output.transferTo,
      prompt: turn.output.prompt,
      state: {
        stepId: s.stepId,
        collected: s.collected,
        skipped: s.skipped,
        awaiting: s.awaiting && s.awaiting.kind !== "tool" ? s.awaiting : null,
        pendingQuestions: s.pendingQuestions,
        fallbackOnly: s.fallbackOnly,
        ended: s.ended,
        outcome: s.outcome,
        qualification: s.qualification,
      },
      toolCalls: [...blockingTools, ...turn.output.backgroundTools].map((c) => ({
        tool: c.tool,
        input: c.input,
        background: c.background,
      })),
      events: [...turn.engineEvents.filter((e) => e.type !== "step"), ...turn.runtimeEvents],
      metrics: turn.metrics,
    };
  }

  private ctx(state: Pick<TestState, "timezone" | "simulatedAt" | "startedAt">): EngineContext {
    const now = state.simulatedAt
      ? new Date(new Date(state.simulatedAt).getTime() + (Date.now() - state.startedAt))
      : new Date();
    return {
      now,
      timezone: state.timezone,
      callerNumber: "+910000000000",
      defaultCountryCode: this.env.DEFAULT_COUNTRY_CODE,
    };
  }

  private async client() {
    if (this.redis.client.status === "wait") await this.redis.client.connect();
    return this.redis.client;
  }

  private async save(id: string, state: TestState): Promise<void> {
    await (await this.client()).set(`testsession:${id}`, JSON.stringify(state), "EX", TTL_SECONDS);
  }

  private async load(id: string): Promise<TestState | null> {
    const raw = await (await this.client()).get(`testsession:${id}`);
    if (!raw) return null;
    const state = JSON.parse(raw) as TestState;
    return { ...state, config: readJson(AgentConfig, state.config, "test_session.config") };
  }
}
