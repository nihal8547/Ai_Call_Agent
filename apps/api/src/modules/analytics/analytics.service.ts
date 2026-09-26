import { Injectable } from "@nestjs/common";
import type { AnalyticsHourly } from "@platform/db";
import {
  AgentConfig,
  hasPermissions,
  histogramPercentile,
  LATENCY_HOPS,
  type LatencyHop,
  mergeHistograms,
  TOOL_SPECS,
  type ToolName,
} from "@platform/shared";
import type { AuthContext } from "../../common/auth/auth.types";
import { TenantDbService } from "../../infra/tenant-db.service";

export type RangeQuery = { from: string; to: string; agentId?: string | undefined };

const COUNTERS = [
  "calls",
  "answered",
  "completed",
  "failed",
  "qualified",
  "disqualified",
  "leadCaptured",
  "booked",
  "enquiryAnswered",
  "handoff",
  "followUp",
  "abandoned",
  "durationSec",
  "turns",
  "fallbackTurns",
  "transfersMissed",
  "questions",
  "questionsAnswered",
  "toolRuns",
  "toolFailures",
] as const;
type Counter = (typeof COUNTERS)[number];
type Totals = Record<Counter, number> & { costMicros: number };

const zero = (): Totals => ({
  ...(Object.fromEntries(COUNTERS.map((c) => [c, 0])) as Record<Counter, number>),
  costMicros: 0,
});
function add(t: Totals, r: AnalyticsHourly): void {
  for (const c of COUNTERS) t[c] += r[c];
  t.costMicros += Number(r.costMicros);
}

/** Days from..to inclusive (YYYY-MM-DD) */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/**
 * Reads the hourly roll-ups (never raw calls), so reports stay fast for any range. Hours are
 * stored in the business's local time, so days here are the business's days.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly tenantDb: TenantDbService) {}

  private async load(tenantId: string, q: RangeQuery) {
    const db = this.tenantDb.db(tenantId);
    const start = new Date(`${q.from}T00:00:00Z`);
    const end = new Date(Date.parse(`${q.to}T00:00:00Z`) + 86_400_000);
    const [rows, agents] = await Promise.all([
      db.analyticsHourly.findMany({
        where: { hour: { gte: start, lt: end }, ...(q.agentId ? { agentId: q.agentId } : {}) },
        orderBy: { hour: "asc" },
      }),
      db.agent.findMany({
        select: { id: true, name: true, publishedVersion: { select: { config: true } } },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    return { rows, agents };
  }

  async report(auth: AuthContext, q: RangeQuery) {
    const { rows, agents } = await this.load(auth.tenantId, q);
    const totals = zero();
    const days = new Map(daysBetween(q.from, q.to).map((d) => [d, zero()]));
    const byHour = Array.from({ length: 24 }, () => 0);
    const fields: Record<string, number> = {};
    const tools: Record<string, { runs: number; failed: number }> = {};
    const reasons: Record<string, number> = {};
    const latency: Partial<Record<LatencyHop, number[]>> = {};
    let updatedAt: Date | null = null;
    for (const r of rows) {
      add(totals, r);
      const day = days.get(r.hour.toISOString().slice(0, 10));
      if (day) add(day, r);
      byHour[r.hour.getUTCHours()]! += r.calls;
      for (const [k, n] of Object.entries(r.fields as Record<string, number>))
        fields[k] = (fields[k] ?? 0) + n;
      for (const [k, t] of Object.entries(r.tools as Record<string, { runs: number; failed: number }>)) {
        const acc = (tools[k] ??= { runs: 0, failed: 0 });
        acc.runs += t.runs;
        acc.failed += t.failed;
      }
      for (const [k, n] of Object.entries(r.ragReasons as Record<string, number>))
        reasons[k] = (reasons[k] ?? 0) + n;
      for (const [hop, h] of Object.entries(r.latency as Record<LatencyHop, number[]>))
        latency[hop as LatencyHop] = mergeHistograms(latency[hop as LatencyHop], h);
      if (!updatedAt || r.updatedAt > updatedAt) updatedAt = r.updatedAt;
    }
    const canSeeCost = hasPermissions(auth.permissions, ["billing:read"]);
    const strip = <T extends Totals>(t: T) => {
      const { costMicros, ...rest } = t;
      return canSeeCost ? { ...rest, costMicros } : rest;
    };

    // Funnel in the order agents ask; the selected agent's own fields when one is chosen
    const labelled = new Map<string, string>();
    for (const a of agents) {
      if (q.agentId && a.id !== q.agentId) continue;
      const config = a.publishedVersion ? AgentConfig.safeParse(a.publishedVersion.config).data : undefined;
      for (const f of config?.qualificationFields ?? [])
        if (!labelled.has(f.key)) labelled.set(f.key, f.label);
    }
    for (const k of Object.keys(fields)) if (!labelled.has(k)) labelled.set(k, k);

    return {
      from: q.from,
      to: q.to,
      agentId: q.agentId ?? null,
      agents: agents.map((a) => ({ id: a.id, name: a.name })),
      updatedAt: updatedAt?.toISOString() ?? null,
      totals: {
        ...strip(totals),
        avgDurationSec: totals.answered ? Math.round(totals.durationSec / totals.answered) : null,
        fallbackRate: totals.turns ? totals.fallbackTurns / totals.turns : 0,
        knowledgeAnswerRate: totals.questions ? totals.questionsAnswered / totals.questions : null,
      },
      series: [...days].map(([day, t]) => ({ day, ...strip(t) })),
      byHour,
      outcomes: {
        LEAD_CAPTURED: totals.leadCaptured,
        APPOINTMENT_BOOKED: totals.booked,
        ENQUIRY_ANSWERED: totals.enquiryAnswered,
        HUMAN_HANDOFF: totals.handoff,
        FOLLOW_UP_REQUIRED: totals.followUp,
        ABANDONED: totals.abandoned,
      },
      funnel: [...labelled].map(([key, label]) => ({ key, label, count: fields[key] ?? 0 })),
      latency: LATENCY_HOPS.map((hop) => {
        const h = latency[hop];
        const count = h?.reduce((n, c) => n + c, 0) ?? 0;
        return {
          hop,
          count,
          p50: h ? histogramPercentile(h, 50) : null,
          p95: h ? histogramPercentile(h, 95) : null,
        };
      }),
      tools: Object.entries(tools)
        .map(([tool, t]) => ({ tool, label: TOOL_SPECS[tool as ToolName]?.label ?? tool, ...t }))
        .sort((a, b) => b.runs - a.runs),
      knowledge: {
        questions: totals.questions,
        answered: totals.questionsAnswered,
        unanswered: Object.entries(reasons)
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count),
      },
      cost: canSeeCost
        ? {
            currency: "USD",
            estimated: true,
            totalMicros: totals.costMicros,
            perCallMicros: totals.calls ? Math.round(totals.costMicros / totals.calls) : null,
          }
        : null,
    };
  }

  /** One row per day and agent, for spreadsheets */
  async csv(auth: AuthContext, q: RangeQuery): Promise<string> {
    const { rows, agents } = await this.load(auth.tenantId, q);
    const names = new Map(agents.map((a) => [a.id, a.name]));
    const groups = new Map<string, Totals & { day: string; agent: string }>();
    for (const r of rows) {
      const day = r.hour.toISOString().slice(0, 10);
      const key = `${day}|${r.agentId}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { ...zero(), day, agent: names.get(r.agentId) ?? r.agentId }));
      add(g, r);
    }
    const canSeeCost = hasPermissions(auth.permissions, ["billing:read"]);
    const header = [
      "Date",
      "Agent",
      "Calls",
      "Answered",
      "Completed",
      "Failed",
      "Qualified",
      "Leads captured",
      "Appointments booked",
      "Questions answered",
      "Transferred",
      "Missed transfers",
      "Follow-ups",
      "Abandoned",
      "Avg duration (s)",
      "Turns",
      "Turns without AI",
      "Knowledge questions",
      "Answered from knowledge",
      "Tool runs",
      "Tool failures",
      ...(canSeeCost ? ["Estimated cost (USD)"] : []),
    ];
    const lines = [...groups.values()]
      .sort((a, b) => a.day.localeCompare(b.day) || a.agent.localeCompare(b.agent))
      .map((g) => [
        g.day,
        g.agent,
        g.calls,
        g.answered,
        g.completed,
        g.failed,
        g.qualified,
        g.leadCaptured,
        g.booked,
        g.enquiryAnswered,
        g.handoff,
        g.transfersMissed,
        g.followUp,
        g.abandoned,
        g.answered ? Math.round(g.durationSec / g.answered) : "",
        g.turns,
        g.fallbackTurns,
        g.questions,
        g.questionsAnswered,
        g.toolRuns,
        g.toolFailures,
        ...(canSeeCost ? [(g.costMicros / 1_000_000).toFixed(4)] : []),
      ]);
    return [header, ...lines].map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }
}

/** Quote for CSV, and neutralise cells a spreadsheet would run as a formula */
export function csvCell(v: string | number): string {
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
