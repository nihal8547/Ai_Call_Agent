import { Prisma, type PrismaClient } from "@prisma/client";
import { latencyBucket, LATENCY_BUCKETS, type LatencyHop, TOOL_BUSINESS_OUTCOMES } from "@platform/shared";
import { withTenant } from "./tenant-client";

type CallRow = {
  id: string;
  agent_id: string;
  hour: string;
  status: string;
  outcome: string;
  qualification_status: string;
  answered: boolean;
  duration_sec: number | null;
  total_turns: number;
  fallback_turns: number;
  cost_micros: bigint;
  fields: string[];
};
type EventRow = {
  call_id: string;
  type: string;
  latency_ms: number | null;
  phase: string | null;
  ok: boolean | null;
  error: string | null;
  tool: string | null;
  answered: string | null;
  reason: string | null;
  transferred: boolean | null;
  understand_ms: number | null;
  phrase_ms: number | null;
  tool_ms: number | null;
  search_ms: number | null;
  answer_ms: number | null;
};

type Bucket = {
  calls: number;
  answered: number;
  completed: number;
  failed: number;
  qualified: number;
  disqualified: number;
  leadCaptured: number;
  booked: number;
  enquiryAnswered: number;
  handoff: number;
  followUp: number;
  abandoned: number;
  durationSec: number;
  turns: number;
  fallbackTurns: number;
  transfersMissed: number;
  questions: number;
  questionsAnswered: number;
  toolRuns: number;
  toolFailures: number;
  costMicros: bigint;
  fields: Record<string, number>;
  tools: Record<string, { runs: number; failed: number }>;
  latency: Partial<Record<LatencyHop, number[]>>;
  ragReasons: Record<string, number>;
};

const OUTCOME_COLUMN: Record<string, keyof Bucket> = {
  LEAD_CAPTURED: "leadCaptured",
  APPOINTMENT_BOOKED: "booked",
  ENQUIRY_ANSWERED: "enquiryAnswered",
  HUMAN_HANDOFF: "handoff",
  FOLLOW_UP_REQUIRED: "followUp",
  ABANDONED: "abandoned",
};
const FAILED_STATUSES = new Set(["FAILED", "NO_ANSWER", "BUSY", "CANCELED"]);
const BUSINESS = new Set<string>(TOOL_BUSINESS_OUTCOMES);

const empty = (): Bucket => ({
  calls: 0,
  answered: 0,
  completed: 0,
  failed: 0,
  qualified: 0,
  disqualified: 0,
  leadCaptured: 0,
  booked: 0,
  enquiryAnswered: 0,
  handoff: 0,
  followUp: 0,
  abandoned: 0,
  durationSec: 0,
  turns: 0,
  fallbackTurns: 0,
  transfersMissed: 0,
  questions: 0,
  questionsAnswered: 0,
  toolRuns: 0,
  toolFailures: 0,
  costMicros: 0n,
  fields: {},
  tools: {},
  latency: {},
  ragReasons: {},
});

function observe(b: Bucket, hop: LatencyHop, ms: number | null): void {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return;
  const h = (b.latency[hop] ??= Array.from({ length: LATENCY_BUCKETS }, () => 0));
  h[latencyBucket(ms)]! += 1;
}

/**
 * Rebuild the hourly roll-ups of every local hour touched by [from, to) for one tenant.
 * Idempotent: the hours are deleted and recomputed from calls, call events and usage in one
 * transaction, so running it again (or concurrently for overlapping ranges) gives the same rows.
 * Calls count in the hour they started (business time zone).
 */
export async function rollupAnalytics(
  prisma: PrismaClient,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<{ hours: number; calls: number }> {
  return withTenant(prisma, tenantId, async (tx) => {
    // One rebuild per tenant at a time; overlapping ranges would otherwise race on delete/insert
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`analytics:${tenantId}`}, 0))`;
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
    const tz = tenant.timezone;
    const last = new Date(to.getTime() - 1);
    const hourRange = Prisma.sql`
      date_trunc('hour', ${from}::timestamptz AT TIME ZONE ${tz})
      AND date_trunc('hour', ${last}::timestamptz AT TIME ZONE ${tz})`;

    const calls = await tx.$queryRaw<CallRow[]>`
      SELECT c.id, c.agent_id,
             to_char(date_trunc('hour', c.started_at AT TIME ZONE ${tz}), 'YYYY-MM-DD"T"HH24:00:00"Z"') AS hour,
             c.status::text, c.outcome::text, c.qualification_status::text,
             c.answered_at IS NOT NULL AS answered, c.duration_sec, c.total_turns, c.fallback_turns, c.cost_micros,
             coalesce(array(SELECT jsonb_object_keys(c.collected_data)), '{}') AS fields
      FROM calls c
      WHERE c.started_at >= ${from}::timestamptz - interval '1 hour'
        AND c.started_at < ${to}::timestamptz + interval '1 hour'
        AND date_trunc('hour', c.started_at AT TIME ZONE ${tz}) BETWEEN ${hourRange}`;

    const events = calls.length
      ? await tx.$queryRaw<EventRow[]>`
          SELECT e.call_id, e.type::text, e.latency_ms,
                 e.payload->>'phase' AS phase, (e.payload->>'ok')::boolean AS ok, e.payload->>'error' AS error,
                 e.payload->>'tool' AS tool, e.payload->>'answered' AS answered, e.payload->>'reason' AS reason,
                 (e.payload->>'transferred')::boolean AS transferred,
                 (e.payload->>'understandMs')::int AS understand_ms, (e.payload->>'phraseMs')::int AS phrase_ms,
                 (e.payload->>'toolMs')::int AS tool_ms, (e.payload->>'searchMs')::int AS search_ms,
                 (e.payload->>'answerMs')::int AS answer_ms
          FROM call_events e
          WHERE e.call_id = ANY(${calls.map((c) => c.id)}::uuid[])
            AND e.type IN ('AGENT_TURN', 'RAG_RETRIEVAL', 'TOOL_CALL', 'HANDOFF')`
      : [];

    const buckets = new Map<string, Bucket & { agentId: string; hour: string }>();
    const byCall = new Map<string, Bucket>();
    for (const c of calls) {
      const key = `${c.agent_id}|${c.hour}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { ...empty(), agentId: c.agent_id, hour: c.hour }));
      byCall.set(c.id, b);
      b.calls++;
      if (c.answered) b.answered++;
      if (c.status === "COMPLETED") b.completed++;
      if (FAILED_STATUSES.has(c.status)) b.failed++;
      if (c.qualification_status === "QUALIFIED") b.qualified++;
      if (c.qualification_status === "DISQUALIFIED") b.disqualified++;
      const col = OUTCOME_COLUMN[c.outcome];
      if (col) (b[col] as number)++;
      b.durationSec += c.duration_sec ?? 0;
      b.turns += c.total_turns;
      b.fallbackTurns += c.fallback_turns;
      b.costMicros += BigInt(c.cost_micros);
      for (const f of c.fields) b.fields[f] = (b.fields[f] ?? 0) + 1;
    }
    for (const e of events) {
      const b = byCall.get(e.call_id);
      if (!b) continue;
      switch (e.type) {
        case "AGENT_TURN":
          observe(b, "turn", e.latency_ms);
          observe(b, "understand", e.understand_ms);
          observe(b, "phrase", e.phrase_ms);
          observe(b, "tool", e.tool_ms);
          break;
        case "RAG_RETRIEVAL":
          if (e.answered === "grounded" || e.answered === "safe") {
            b.questions++;
            if (e.answered === "grounded") b.questionsAnswered++;
            else {
              const reason = e.reason ?? "no_answer";
              b.ragReasons[reason] = (b.ragReasons[reason] ?? 0) + 1;
            }
          }
          observe(b, "search", e.search_ms);
          observe(b, "answer", e.answer_ms);
          break;
        case "TOOL_CALL": {
          // One row per execution (live or background); timeouts are recorded without a phase
          const executed = e.phase === "executed" || (e.phase === null && e.error === "timeout");
          if (!executed || !e.tool) break;
          const t = (b.tools[e.tool] ??= { runs: 0, failed: 0 });
          t.runs++;
          b.toolRuns++;
          if (e.ok === false && !BUSINESS.has(e.error ?? "")) {
            t.failed++;
            b.toolFailures++;
          }
          break;
        }
        case "HANDOFF":
          if (e.transferred === false) b.transfersMissed++;
          break;
      }
    }

    await tx.$executeRaw`DELETE FROM analytics_hourly WHERE hour BETWEEN ${hourRange}`;
    if (buckets.size)
      await tx.analyticsHourly.createMany({
        data: [...buckets.values()].map(({ agentId, hour, ...b }) => ({
          tenantId,
          agentId,
          hour: new Date(hour),
          ...b,
          fields: b.fields,
          tools: b.tools,
          latency: b.latency,
          ragReasons: b.ragReasons,
        })),
      });
    return { hours: buckets.size, calls: calls.length };
  });
}
