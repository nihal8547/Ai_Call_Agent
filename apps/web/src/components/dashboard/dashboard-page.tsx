"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useCan, useMe } from "@/components/app/me-context";
import { Alert, Card, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { fmtCompact, fmtDuration, fmtPercent, plural } from "@/lib/format";
import type { Summary } from "@/lib/types";
import { CallsChart } from "./calls-chart";

const RANGES = [7, 30, 90] as const;

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
    </Card>
  );
}

export function DashboardPage() {
  const me = useMe();
  const canSee = useCan("analytics:read");
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const summary = useQuery({
    queryKey: ["analytics", days],
    queryFn: () => api<Summary>(`/analytics/summary?days=${days}`),
    enabled: canSee,
  });

  if (!canSee) {
    return (
      <>
        <PageHeader title={`Welcome, ${me.user.name}`} description={me.tenant.name} />
        <Card>
          <p className="text-sm text-slate-500">Use the menu to see your calls, leads and appointments.</p>
        </Card>
      </>
    );
  }

  const t = summary.data?.totals;
  return (
    <>
      <PageHeader
        title="Dashboard"
        description={me.tenant.name}
        actions={
          <div
            role="group"
            aria-label="Date range"
            className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900"
          >
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setDays(r)}
                aria-pressed={days === r}
                className={`rounded-md px-3 py-1.5 text-sm ${days === r ? "bg-brand-600 text-white" : "text-slate-600 dark:text-slate-300"}`}
              >
                {r} days
              </button>
            ))}
          </div>
        }
      />
      {summary.error ? <Alert>{errorMessage(summary.error)}</Alert> : null}
      {t && t.calls === 0 ? (
        <Card className="mb-6">
          <h2 className="font-semibold">No calls yet</h2>
          <p className="mt-1 text-sm text-slate-500">
            Create an agent, publish it and connect a phone number. Calls will show up here.{" "}
            <Link href={`/t/${me.tenant.slug}/agents`} className="font-medium text-brand-600 hover:underline">
              Go to AI agents
            </Link>
          </p>
        </Card>
      ) : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Total calls"
          value={t ? fmtCompact(t.calls) : "…"}
          hint={t ? `${fmtCompact(t.answered)} answered` : undefined}
        />
        <Stat
          label="Qualified leads"
          value={t ? fmtCompact(t.qualified) : "…"}
          hint={t ? `${plural(t.leads, "lead")} in total` : undefined}
        />
        <Stat label="Appointments booked" value={t ? fmtCompact(t.booked) : "…"} />
        <Stat label="Human transfers" value={t ? fmtCompact(t.transfers) : "…"} />
        <Stat
          label="Completed"
          value={t ? fmtCompact(t.completed) : "…"}
          hint={t ? `${fmtCompact(t.failed)} failed or missed` : undefined}
        />
        <Stat label="Average duration" value={t ? fmtDuration(t.avgDurationSec) : "…"} />
        <Stat label="Need follow-up" value={t ? fmtCompact(t.followUps) : "…"} />
        <Stat
          label="AI fallback rate"
          value={t ? fmtPercent(t.fallbackRate) : "…"}
          hint="Turns answered without the LLM"
        />
      </div>
      <Card className="mt-6">
        <h2 className="font-semibold">Calls per day</h2>
        <p className="mb-4 text-sm text-slate-500">Last {days} days, in your business time zone</p>
        {summary.data ? (
          <CallsChart data={summary.data.series} />
        ) : (
          <div className="h-52 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
        )}
      </Card>
    </>
  );
}
