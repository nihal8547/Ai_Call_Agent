import { type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { RuntimeTurn } from "@platform/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantDbService } from "../src/infra/tenant-db.service";
import { turnUsage } from "../src/modules/usage/usage.service";
import { addMember, createTestApp, hasTestDb, registerOwner } from "./support/app";
import { phoneCall, provisionAgent, twilioPost } from "./support/telephony";

describe("usage of one turn", () => {
  it("adds up LLM tokens per model, the knowledge lookup, speech out and speech in", () => {
    const turn = {
      speech: "Free parking is in the basement.",
      runtimeEvents: [
        {
          type: "llm_call",
          purpose: "understand",
          ok: true,
          latencyMs: 900,
          model: "gemini-flash-latest",
          inputTokens: 700,
          outputTokens: 40,
        },
        {
          type: "llm_call",
          purpose: "phrase",
          ok: false,
          error: "timeout",
          latencyMs: 700,
          model: "gemini-flash-latest",
          inputTokens: 0,
          outputTokens: 0,
        },
        {
          type: "retrieval",
          ok: true,
          answered: true,
          latencyMs: 1200,
          sources: 1,
          usage: {
            embedModel: "gemini-embedding-001",
            embeddingTokens: 9,
            llmModel: "gemini-flash-latest",
            inputTokens: 900,
            outputTokens: 30,
          },
        },
      ],
    } as unknown as RuntimeTurn;
    expect(turnUsage(turn, { callerSpoke: true })).toEqual([
      { kind: "LLM_INPUT_TOKENS", quantity: 1600, provider: "gemini", model: "gemini-flash-latest" },
      { kind: "LLM_OUTPUT_TOKENS", quantity: 70, provider: "gemini", model: "gemini-flash-latest" },
      { kind: "EMBEDDING_TOKENS", quantity: 9, provider: "gemini", model: "gemini-embedding-001" },
      { kind: "TTS_CHARACTERS", quantity: 32, provider: "twilio", model: null },
      { kind: "STT_SECONDS", quantity: 15, provider: "twilio", model: null },
    ]);
  });
});

describe.skipIf(!hasTestDb)("P11: usage metering and cost estimates", () => {
  let app: NestFastifyApplication;
  let owner: Awaited<ReturnType<typeof registerOwner>>;
  const db = () => app.get(TenantDbService).db(owner.me.tenant.id);

  beforeAll(async () => {
    // The business's own contract rate for minutes
    app = await createTestApp({ USAGE_PRICES: JSON.stringify({ TELEPHONY_MINUTES: 10_000 }) });
    owner = await registerOwner(app, "usage");
  });
  afterAll(() => app.close());

  it("meters a phone call: speech, recognition and minutes, with the call's running cost", async () => {
    const clinic = await provisionAgent(app, owner.me.tenant.id, "clinic-reception", {
      workingHours: undefined,
    });
    const call = await phoneCall(app, clinic.e164, ["Priya", "cleaning"]);
    await twilioPost(app, "/telephony/twilio/status", {
      ...call.base,
      CallStatus: "completed",
      CallDuration: "75",
    });
    const record = await db().call.findUniqueOrThrow({
      where: { providerCallSid: call.callSid },
      include: { usage: true },
    });
    const byKind = (k: string) =>
      record.usage.filter((u) => u.kind === k).reduce((n, u) => n + Number(u.quantity), 0);
    const spoken = call.replies.reduce((n, r) => n + r.say.length, 0);
    expect(byKind("TTS_CHARACTERS")).toBe(spoken);
    expect(byKind("STT_SECONDS")).toBe(30);
    expect(byKind("TELEPHONY_MINUTES")).toBe(2);
    // 2 minutes at the contract rate + 30 s of recognition + 16 µ$ per character spoken
    const expected = 2 * 10_000 + Math.round(30 * (20_000 / 15)) + spoken * 16;
    expect(Number(record.costMicros)).toBeGreaterThanOrEqual(expected - 3);
    expect(Number(record.costMicros)).toBeLessThanOrEqual(expected + 3);
    expect(record.usage.reduce((n, u) => n + Number(u.costMicros), 0)).toBe(Number(record.costMicros));
  });

  it("shows the estimate to billing people only", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    const res = await owner.client.get(`/api/v1/usage/summary?from=${today}&to=${today}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ currency: "USD", estimated: true, from: today, to: today });
    expect(body.lines).toContainEqual(
      expect.objectContaining({
        kind: "TELEPHONY_MINUTES",
        quantity: 2,
        costMicros: 20_000,
        unitPriceMicros: 10_000,
      }),
    );
    expect(body.totalMicros).toBe(
      body.lines.reduce((n: number, l: { costMicros: number }) => n + l.costMicros, 0),
    );
    expect(body.days).toEqual([{ day: today, costMicros: body.totalMicros }]);

    const manager = await addMember(app, owner, "MANAGER");
    expect((await manager.client.get(`/api/v1/usage/summary?from=${today}&to=${today}`)).statusCode).toBe(
      403,
    );
    expect((await owner.client.get(`/api/v1/usage/summary?from=${today}&to=2020-01-01`)).statusCode).toBe(
      400,
    );
  });
});
