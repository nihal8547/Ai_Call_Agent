"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useCan, useMe } from "@/components/app/me-context";
import { CallsChart } from "@/components/dashboard/calls-chart";
import { SelectField, TextField } from "@/components/ui/field";
import { Alert, Card, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { fmtDateTime, fmtDuration, fmtPercent, humanize, plural } from "@/lib/format";
import { addDays, localDate } from "@/lib/tz";
import { BarList, ColumnChart } from "./charts";

type Totals = {
  calls: number;
  answered: number;
  completed: number;
  failed: number;
  qualified: number;
  booked: number;
  enquiryAnswered: number;
  handoff: number;
  transfersMissed: number;
  followUp: number;
  questions: number;
  questionsAnswered: number;
  toolRuns: number;
  toolFailures: number;
  turns: number;
  fallbackTurns: number;
  costMicros?: number;
  avgDurationSec: number | null;
  fallbackRate: number;
  knowledgeAnswerRate: number | null;
};
type Report = {
  from: string;
  to: string;
  agents: { id: string; name: string }[];
  updatedAt: string | null;
  totals: Totals;
  series: { day: string; calls: number; booked: number }[];
  byHour: number[];
  outcomes: Record<string, number>;
  funnel: { key: string; label: string; count: number }[];
  latency: { hop: string; count: number; p50: number | null; p95: number | null }[];
  tools: { tool: string; label: string; runs: number; failed: number }[];
  knowledge: { questions: number; answered: number; unanswered: { reason: string; count: number }[] };
  cost: { currency: string; totalMicros: number; perCallMicros: number | null } | null;
};
type Usage = {
  totalMicros: number;
  lines: {
    kind: string;
    provider: string | null;
    model: string | null;
    quantity: number;
    costMicros: number;
    unitPriceMicros: number;
  }[];
};

const PRESETS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "custom", label: "Custom range" },
] as const;
const HOPS: Record<string, string> = {
  turn: "Whole reply",
  understand: "Understanding (AI)",
  search: "Knowledge search",
  answer: "Knowledge answer (AI)",
  tool: "Tools",
  phrase: "Phrasing (AI)",
};
const REASONS: Record<string, string> = {
  not_relevant: "Nothing relevant in the documents",
  no_hits: "No matching documents",
  no_collections: "Agent has no knowledge",
  not_in_sources: "Not in the documents (AI checked)",
  weak_match: "Only loosely related text",
  llm_error: "AI unavailable",
  error: "Search failed",
  no_answer: "Not answered",
};
const USAGE: Record<string, [string, string]> = {
  TELEPHONY_MINUTES: ["Phone minutes", "min"],
  LLM_INPUT_TOKENS: ["AI input", "tokens"],
  LLM_OUTPUT_TOKENS: ["AI output", "tokens"],
  EMBEDDING_TOKENS: ["Knowledge embeddings", "tokens"],
  TTS_CHARACTERS: ["Speech (text-to-speech)", "characters"],
  STT_SECONDS: ["Speech recognition", "seconds"],
};

const money = (micros: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: micros < 10_000_000 ? 4 : 2,
  }).format(micros / 1_000_000);
const ms = (v: number | null) =>
  v === null ? "—" : v >= 5000 ? "≥ 5 s" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`;
const share = (n: number, of: number) => (of ? fmtPercent(n / of) : "—");

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
    </Card>
  );
}

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-5">
      <h2 className="font-semibold">{title}</h2>
      {description ? <p className="mt-0.5 text-sm text-slate-500">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </Card>
  );
}

export function AnalyticsPage() {
  const me = useMe();
  const canSeeCost = useCan("billing:read");
  const tz = me.tenant.timezone;
  const today = localDate(new Date(), tz);
  const [preset, setPreset] = useState<(typeof PRESETS)[number]["value"]>("30");
  const [custom, setCustom] = useState({ from: addDays(today, -29), to: today });
  const [agentId, setAgentId] = useState("");
  const range = preset === "custom" ? custom : { from: addDays(today, -(Number(preset) - 1)), to: today };
  const params = new URLSearchParams({ ...range, ...(agentId ? { agentId } : {}) }).toString();

  const report = useQuery({
    queryKey: ["analytics-report", params],
    queryFn: () => api<Report>(`/analytics/report?${params}`),
  });
  const usage = useQuery({
    queryKey: ["usage", range.from, range.to],
    queryFn: () => api<Usage>(`/usage/summary?from=${range.from}&to=${range.to}`),
    enabled: canSeeCost,
  });
  const r = report.data;
  const t = r?.totals;

  return (
    <>
      <PageHeader
        title="Analytics"
        description="How your agents are doing: calls, outcomes, what callers told them, speed and cost."
        actions={
          <a
            href={`/api/v1/analytics/export.csv?${params}`}
            className="inline-flex h-10 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
          >
            Export CSV
          </a>
        }
      />
      {/* All filters in one row above the charts */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-[200px_160px_160px_220px] lg:items-end">
        <SelectField
          label="Period"
          value={preset}
          onChange={(e) => setPreset(e.target.value as (typeof PRESETS)[number]["value"])}
        >
          {PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </SelectField>
        {preset === "custom" ? (
          <>
            <TextField
              label="From"
              type="date"
              value={custom.from}
              max={custom.to}
              onChange={(e) => e.target.value && setCustom((c) => ({ ...c, from: e.target.value }))}
            />
            <TextField
              label="To"
              type="date"
              value={custom.to}
              min={custom.from}
              max={today}
              onChange={(e) => e.target.value && setCustom((c) => ({ ...c, to: e.target.value }))}
            />
          </>
        ) : null}
        <SelectField label="Agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">All agents</option>
          {r?.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </SelectField>
      </div>

      {report.error ? <Alert>{errorMessage(report.error)}</Alert> : null}
      {report.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {r && t ? (
        <div className="space-y-6">
          <p className="text-xs text-slate-500">
            {r.updatedAt
              ? `Figures refresh a minute or two after each call · last updated ${fmtDateTime(r.updatedAt)}`
              : "No calls in this period yet. Figures appear a minute or two after calls end."}
          </p>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat
              label="Calls"
              value={t.calls.toLocaleString()}
              hint={`${plural(t.answered, "answered call")}`}
            />
            <Stat
              label="Appointments booked"
              value={t.booked.toLocaleString()}
              hint={`${share(t.booked, t.calls)} of calls`}
            />
            <Stat
              label="Qualified leads"
              value={t.qualified.toLocaleString()}
              hint={`${share(t.qualified, t.calls)} of calls`}
            />
            <Stat
              label="Transfers to staff"
              value={(t.handoff + t.transfersMissed).toLocaleString()}
              hint={
                t.transfersMissed
                  ? `${t.handoff.toLocaleString()} connected · ${t.transfersMissed.toLocaleString()} not (no answer or closed)`
                  : t.handoff
                    ? "all connected"
                    : undefined
              }
            />
            <Stat label="Need a follow-up" value={t.followUp.toLocaleString()} />
            <Stat label="Average call" value={fmtDuration(t.avgDurationSec)} />
            <Stat
              label="Questions answered from knowledge"
              value={t.knowledgeAnswerRate === null ? "—" : fmtPercent(t.knowledgeAnswerRate)}
              hint={plural(t.questions, "question")}
            />
            {r.cost ? (
              <Stat
                label="Estimated cost"
                value={money(r.cost.totalMicros)}
                hint={r.cost.perCallMicros === null ? undefined : `${money(r.cost.perCallMicros)} per call`}
              />
            ) : (
              <Stat
                label="Replies without AI"
                value={fmtPercent(t.fallbackRate)}
                hint={plural(t.turns, "turn")}
              />
            )}
          </div>

          <Panel title="Calls per day" description={`${r.from} to ${r.to}, in ${tz} time`}>
            <CallsChart data={r.series} />
          </Panel>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="How calls ended">
              <BarList
                caption="Calls by outcome"
                items={Object.entries(r.outcomes)
                  .map(([k, v]) => ({ key: k, label: humanize(k), value: v, detail: share(v, t.calls) }))
                  .sort((a, b) => b.value - a.value)}
              />
            </Panel>
            <Panel
              title="What callers told the agent"
              description="Calls that gave each answer, in the order agents ask"
            >
              {r.funnel.length ? (
                <BarList
                  caption="Calls per collected answer"
                  max={t.answered}
                  items={r.funnel.map((f) => ({
                    key: f.key,
                    label: f.label,
                    value: f.count,
                    detail: share(f.count, t.answered),
                  }))}
                />
              ) : (
                <p className="text-sm text-slate-500">No answers collected yet.</p>
              )}
            </Panel>
          </div>

          <Panel title="Busiest hours" description={`Calls by hour of the day (${tz})`}>
            <ColumnChart
              caption="Calls by hour of the day"
              unit={(n) => plural(n, "call")}
              data={r.byHour.map((v, h) => ({
                label: `${String(h).padStart(2, "0")}:00–${String(h).padStart(2, "0")}:59`,
                short: `${String(h).padStart(2, "0")}h`,
                value: v,
              }))}
            />
          </Panel>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Speed" description="Time callers waited, per step (approximate percentiles)">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-500">
                    <th scope="col" className="py-1.5 font-medium">
                      Step
                    </th>
                    <th scope="col" className="py-1.5 text-right font-medium">
                      Typical (p50)
                    </th>
                    <th scope="col" className="py-1.5 text-right font-medium">
                      Slowest 5% (p95)
                    </th>
                    <th scope="col" className="py-1.5 text-right font-medium">
                      Samples
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {r.latency.map((l) => (
                    <tr key={l.hop} className="border-t border-slate-100 dark:border-slate-800">
                      <th scope="row" className="py-1.5 text-left font-normal">
                        {HOPS[l.hop] ?? l.hop}
                      </th>
                      <td className="py-1.5 text-right tabular-nums">{ms(l.p50)}</td>
                      <td className="py-1.5 text-right tabular-nums">{ms(l.p95)}</td>
                      <td className="py-1.5 text-right text-slate-500 tabular-nums">
                        {l.count.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
            <Panel title="Tools" description="Bookings, lookups and deliveries the agents ran">
              {r.tools.length ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-slate-500">
                      <th scope="col" className="py-1.5 font-medium">
                        Tool
                      </th>
                      <th scope="col" className="py-1.5 text-right font-medium">
                        Runs
                      </th>
                      <th scope="col" className="py-1.5 text-right font-medium">
                        Failed
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.tools.map((x) => (
                      <tr key={x.tool} className="border-t border-slate-100 dark:border-slate-800">
                        <th scope="row" className="py-1.5 text-left font-normal">
                          {x.label}
                        </th>
                        <td className="py-1.5 text-right tabular-nums">{x.runs.toLocaleString()}</td>
                        <td
                          className={
                            x.failed
                              ? "py-1.5 text-right font-medium text-red-700 tabular-nums dark:text-red-300"
                              : "py-1.5 text-right tabular-nums"
                          }
                        >
                          {x.failed ? `${x.failed.toLocaleString()} (${share(x.failed, x.runs)})` : "0"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-sm text-slate-500">No tools ran in this period.</p>
              )}
            </Panel>
          </div>

          <Panel
            title="Knowledge questions"
            description={`${plural(r.knowledge.questions, "question")} asked, ${r.knowledge.answered.toLocaleString()} answered from your documents`}
          >
            {r.knowledge.unanswered.length ? (
              <BarList
                caption="Why questions were not answered"
                items={r.knowledge.unanswered.map((u) => ({
                  key: u.reason,
                  label: REASONS[u.reason] ?? humanize(u.reason),
                  value: u.count,
                }))}
              />
            ) : (
              <p className="text-sm text-slate-500">Every question was answered.</p>
            )}
          </Panel>

          {canSeeCost && usage.data ? (
            <Panel
              title="Usage and estimated cost"
              description="From list prices unless your platform sets its own rates. An estimate, not an invoice."
            >
              {usage.data.lines.length ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-slate-500">
                      <th scope="col" className="py-1.5 font-medium">
                        What
                      </th>
                      <th scope="col" className="py-1.5 text-right font-medium">
                        Used
                      </th>
                      <th scope="col" className="py-1.5 text-right font-medium">
                        Estimated cost
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.data.lines.map((l) => (
                      <tr
                        key={`${l.kind}-${l.provider}-${l.model}`}
                        className="border-t border-slate-100 dark:border-slate-800"
                      >
                        <th scope="row" className="py-1.5 text-left font-normal">
                          {USAGE[l.kind]?.[0] ?? humanize(l.kind)}
                          {l.model ? <span className="ml-1 text-xs text-slate-500">{l.model}</span> : null}
                        </th>
                        <td className="py-1.5 text-right tabular-nums">
                          {l.quantity.toLocaleString()} {USAGE[l.kind]?.[1] ?? ""}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">{money(l.costMicros)}</td>
                      </tr>
                    ))}
                    <tr className="border-t border-slate-300 font-semibold dark:border-slate-700">
                      <th scope="row" className="py-1.5 text-left">
                        Total
                      </th>
                      <td />
                      <td className="py-1.5 text-right tabular-nums">{money(usage.data.totalMicros)}</td>
                    </tr>
                  </tbody>
                </table>
              ) : (
                <p className="text-sm text-slate-500">No usage in this period.</p>
              )}
            </Panel>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
