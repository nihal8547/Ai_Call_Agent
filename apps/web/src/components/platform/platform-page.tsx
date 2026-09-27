"use client";

import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useMe } from "@/components/app/me-context";
import { Alert, Card, PageHeader } from "@/components/ui/misc";
import { StatusPill } from "@/components/ui/status-pill";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { cn } from "@/lib/cn";
import { fmtDate } from "@/lib/format";
import { type PlatformBusiness, usd } from "./types";

type Totals = {
  businesses: number;
  suspended: number;
  calls30d: number;
  minutes30d: number;
  costMicros30d: number;
  failedJobs: number;
};

const STATUSES = [
  { key: "all", label: "All" },
  { key: "ACTIVE", label: "Active" },
  { key: "SUSPENDED", label: "Suspended" },
] as const;

/** The platform operator's view of every business */
export function PlatformPage() {
  const me = useMe();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<(typeof STATUSES)[number]["key"]>("all");
  const list = useQuery({
    queryKey: ["platform-tenants", q, status],
    queryFn: () =>
      api<{ items: PlatformBusiness[]; totals: Totals }>(
        `/platform/tenants?status=${status}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`,
      ),
    placeholderData: (prev) => prev,
  });
  const t = list.data?.totals;
  return (
    <>
      <PageHeader
        title="Businesses"
        description="Every business on the platform: activity in the last 30 days, plans and limits."
      />
      {list.isError ? <Alert>{errorMessage(list.error)}</Alert> : null}
      {t ? (
        <dl className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {[
            ["Businesses", t.businesses],
            ["Suspended", t.suspended],
            ["Calls (30 days)", t.calls30d.toLocaleString()],
            ["Minutes (30 days)", t.minutes30d.toLocaleString()],
            ["Cost (30 days)", usd(t.costMicros30d)],
            ["Failed jobs", t.failedJobs],
          ].map(([label, value]) => (
            <Card key={String(label)} className="p-4">
              <dt className="text-xs text-slate-500">{label}</dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums text-slate-950">{value}</dd>
            </Card>
          ))}
        </dl>
      ) : null}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="relative w-full max-w-sm">
          <span className="sr-only">Search businesses</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400"
            aria-hidden
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, address or owner email"
            className="h-10 w-full rounded-lg border border-slate-200 pr-3 pl-9 text-sm outline-none focus:border-slate-400"
          />
        </label>
        <div className="flex gap-1" role="group" aria-label="Status">
          {STATUSES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setStatus(s.key)}
              aria-pressed={status === s.key}
              className={cn(
                "rounded-full px-3 py-1.5 text-sm",
                status === s.key ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs text-slate-500 uppercase">
            <tr>
              <th className="px-4 py-3 font-medium">Business</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Plan</th>
              <th className="px-4 py-3 text-right font-medium">Calls</th>
              <th className="px-4 py-3 text-right font-medium">Minutes</th>
              <th className="px-4 py-3 text-right font-medium">Cost</th>
              <th className="hidden px-4 py-3 text-right font-medium md:table-cell">Failed jobs</th>
              <th className="hidden px-4 py-3 font-medium lg:table-cell">Last call</th>
            </tr>
          </thead>
          <tbody>
            {(list.data?.items ?? []).map((b) => (
              <tr key={b.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                <td className="px-4 py-3">
                  <Link
                    href={`/t/${me.tenant.slug}/platform/${b.id}`}
                    className="font-medium text-slate-950 hover:underline"
                  >
                    {b.name}
                  </Link>
                  <p className="text-xs text-slate-500">
                    {b.ownerEmail ?? "no owner"} · since {fmtDate(b.createdAt)}
                  </p>
                </td>
                <td className="px-4 py-3">
                  <StatusPill value={b.status} />
                </td>
                <td className="px-4 py-3 text-slate-700">{b.plan}</td>
                <td className="px-4 py-3 text-right tabular-nums">{b.calls30d.toLocaleString()}</td>
                <td className="px-4 py-3 text-right tabular-nums">{b.minutes30d.toLocaleString()}</td>
                <td className="px-4 py-3 text-right tabular-nums">{usd(b.costMicros30d)}</td>
                <td
                  className={cn(
                    "hidden px-4 py-3 text-right tabular-nums md:table-cell",
                    b.failedJobs ? "text-red-600" : "",
                  )}
                >
                  {b.failedJobs}
                </td>
                <td className="hidden px-4 py-3 whitespace-nowrap text-slate-500 lg:table-cell">
                  {b.lastCallAt ? fmtDate(b.lastCallAt) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.isLoading ? <p className="p-6 text-sm text-slate-500">Loading…</p> : null}
        {list.isSuccess && !list.data.items.length ? (
          <p className="p-6 text-sm text-slate-500">No businesses match.</p>
        ) : null}
      </Card>
    </>
  );
}
