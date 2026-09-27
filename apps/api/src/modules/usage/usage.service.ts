import { Inject, Injectable } from "@nestjs/common";
import type { TenantTx } from "@platform/db";
import { costMicros, mergeUsage, type PriceTable, priceTable, type UsageLine } from "@platform/shared";
import type { RuntimeEvent, RuntimeTurn } from "@platform/runtime";
import { API_ENV, type ApiEnv } from "../../config/env";
import { MetricsService } from "../../observability/metrics.service";

/** Twilio bills <Gather> speech recognition per 15-second block */
const STT_BLOCK_SECONDS = 15;

const providerOf = (model: string) =>
  model.startsWith("gemini") ? "gemini" : model.startsWith("hashing") ? "local" : model.split(/[-:/]/)[0]!;

/**
 * What one conversational turn consumed: LLM tokens (understanding, phrasing, knowledge answers),
 * the query embedding, the reply's text-to-speech characters, and speech recognition of the caller.
 */
export function turnUsage(
  turn: RuntimeTurn,
  opts: { callerSpoke: boolean; /** false for chats: nothing is spoken or recognised */ spoken?: boolean },
): UsageLine[] {
  const lines: UsageLine[] = [];
  const llm = (model: string, input: number, output: number) => {
    lines.push({ kind: "LLM_INPUT_TOKENS", quantity: input, provider: providerOf(model), model });
    lines.push({ kind: "LLM_OUTPUT_TOKENS", quantity: output, provider: providerOf(model), model });
  };
  for (const e of turn.runtimeEvents as RuntimeEvent[]) {
    if (e.type === "llm_call" && e.ok) llm(e.model, e.inputTokens, e.outputTokens);
    if (e.type === "retrieval" && e.usage) {
      const u = e.usage;
      if (u.embedModel && u.embeddingTokens)
        lines.push({
          kind: "EMBEDDING_TOKENS",
          quantity: u.embeddingTokens,
          provider: providerOf(u.embedModel),
          model: u.embedModel,
        });
      if (u.llmModel) llm(u.llmModel, u.inputTokens ?? 0, u.outputTokens ?? 0);
    }
  }
  if (opts.spoken === false) return mergeUsage(lines);
  if (turn.speech)
    lines.push({ kind: "TTS_CHARACTERS", quantity: turn.speech.length, provider: "twilio", model: null });
  if (opts.callerSpoke)
    lines.push({ kind: "STT_SECONDS", quantity: STT_BLOCK_SECONDS, provider: "twilio", model: null });
  return mergeUsage(lines);
}

/** Writes usage with its estimated cost, and keeps each call's running cost */
@Injectable()
export class UsageService {
  readonly prices: PriceTable;

  constructor(
    @Inject(API_ENV) env: ApiEnv,
    private readonly metrics: MetricsService,
  ) {
    this.prices = priceTable(env.USAGE_PRICES);
  }

  /** Inside the caller's transaction; returns the added cost in micro-dollars */
  async record(tx: TenantTx, tenantId: string, callId: string | null, lines: UsageLine[]): Promise<bigint> {
    const rows = mergeUsage(lines).map((l) => ({
      tenantId,
      callId,
      kind: l.kind,
      quantity: BigInt(Math.round(l.quantity)),
      costMicros: costMicros(this.prices, l.kind, l.quantity, l.model),
      provider: l.provider.slice(0, 40),
      model: l.model?.slice(0, 80) ?? null,
    }));
    if (!rows.length) return 0n;
    for (const r of rows) this.metrics.cost.inc({ kind: r.kind }, Number(r.costMicros));
    await tx.usageRecord.createMany({ data: rows });
    const total = rows.reduce((n, r) => n + r.costMicros, 0n);
    if (callId && total > 0n)
      await tx.call.update({ where: { id: callId }, data: { costMicros: { increment: total } } });
    return total;
  }
}
