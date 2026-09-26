"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useMe } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/field";
import { Alert, Card, PageHeader } from "@/components/ui/misc";
import { StatusPill } from "@/components/ui/status-pill";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { cn } from "@/lib/cn";
import { humanize } from "@/lib/format";
import type { Appointment, Page } from "@/lib/types";
import { addDays, localDate, localTime, weekStart, zonedToUtc } from "@/lib/tz";
import { AppointmentDetail } from "./appointment-detail";

const STATUSES = ["UPCOMING", "COMPLETED", "CANCELLED", "RESCHEDULED", "NO_SHOW"] as const;

export function AppointmentsPage() {
  const me = useMe();
  const tz = me.tenant.timezone;
  const router = useRouter();
  const params = useSearchParams();
  const view = params.get("view") === "list" ? "list" : "week";
  const today = localDate(new Date(), tz);
  const week = weekStart(params.get("week") ?? today);
  const status = params.get("status") ?? "";
  const [open, setOpen] = useState<Appointment | null>(null);
  const setParam = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    router.replace(`?${next}`);
  };

  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const weekQuery = useQuery({
    queryKey: ["appointments", "week", week, status],
    enabled: view === "week",
    queryFn: () =>
      api<Page<Appointment>>(
        `/appointments?${new URLSearchParams({
          // A day of margin each side: bookings are grouped by their own time zone below
          from: zonedToUtc(addDays(week, -1), "00:00", tz).toISOString(),
          to: zonedToUtc(addDays(week, 8), "00:00", tz).toISOString(),
          limit: "100",
          ...(status ? { status } : {}),
        })}`,
      ),
  });
  const listQuery = useInfiniteQuery({
    queryKey: ["appointments", "list", status],
    enabled: view === "list",
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      api<Page<Appointment>>(
        `/appointments?${new URLSearchParams({
          from: zonedToUtc(today, "00:00", tz).toISOString(),
          limit: "50",
          ...(status ? { status } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        })}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const error = view === "week" ? weekQuery.error : listQuery.error;
  const byDay = (d: string) =>
    (weekQuery.data?.items ?? []).filter((a) => localDate(new Date(a.startsAt), a.timezone) === d);
  const dayLabel = (d: string, style: "short" | "long") =>
    new Intl.DateTimeFormat(undefined, {
      weekday: style,
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(new Date(`${d}T00:00:00Z`));

  return (
    <>
      <PageHeader
        title="Appointments"
        description="Booked by your agents and your team. Times are local to each booking (the agent's time zone)."
        actions={
          <div
            className="flex rounded-lg border border-slate-300 p-0.5 dark:border-slate-700"
            role="group"
            aria-label="View"
          >
            {(["week", "list"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setParam({ view: v === "week" ? null : v })}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm",
                  view === v
                    ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                    : "text-slate-600 dark:text-slate-300",
                )}
              >
                {v === "week" ? "Week" : "List"}
              </button>
            ))}
          </div>
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        {view === "week" ? (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              aria-label="Previous week"
              onClick={() => setParam({ week: addDays(week, -7) })}
            >
              ←
            </Button>
            <Button
              variant="secondary"
              className="whitespace-nowrap"
              onClick={() => setParam({ week: null })}
            >
              This week
            </Button>
            <Button
              variant="secondary"
              aria-label="Next week"
              onClick={() => setParam({ week: addDays(week, 7) })}
            >
              →
            </Button>
            <span className="ml-2 text-sm font-medium">
              {dayLabel(week, "short")} – {dayLabel(addDays(week, 6), "short")}
            </span>
          </div>
        ) : null}
        <SelectField
          label="Status"
          value={status}
          onChange={(e) => setParam({ status: e.target.value || null })}
          className="w-44"
        >
          <option value="">All</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {humanize(s)}
            </option>
          ))}
        </SelectField>
      </div>
      {error ? <Alert>{errorMessage(error)}</Alert> : null}

      {view === "week" ? (
        <div className="grid gap-3 md:grid-cols-7">
          {days.map((d) => {
            const items = byDay(d);
            return (
              <section
                key={d}
                aria-label={dayLabel(d, "long")}
                className={cn(
                  "rounded-2xl border bg-white p-2 md:min-h-32 dark:bg-slate-900",
                  d === today ? "border-brand-500" : "border-slate-200 dark:border-slate-800",
                )}
              >
                <h2
                  className={cn(
                    "px-1 pb-2 text-xs font-semibold uppercase",
                    d === today ? "text-brand-600" : "text-slate-500",
                  )}
                >
                  {dayLabel(d, "short")}
                </h2>
                <ul className="space-y-2">
                  {items.map((a) => (
                    <li key={a.id}>
                      <AppointmentChip a={a} onOpen={() => setOpen(a)} />
                    </li>
                  ))}
                </ul>
                {weekQuery.data && !items.length ? <p className="px-1 text-xs text-slate-400">—</p> : null}
              </section>
            );
          })}
        </div>
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {(listQuery.data?.pages.flatMap((p) => p.items) ?? []).map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => setOpen(a)}
                  className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800/50"
                >
                  <span className="w-40 font-medium tabular-nums">
                    {dayLabel(localDate(new Date(a.startsAt), a.timezone), "short")}{" "}
                    {localTime(new Date(a.startsAt), a.timezone)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {a.title}
                    <span className="text-slate-500">
                      {" "}
                      · {a.lead?.customerName ?? a.lead?.phone ?? "Unknown caller"}
                    </span>
                  </span>
                  <StatusPill value={a.status} />
                </button>
              </li>
            ))}
          </ul>
          {listQuery.data && !listQuery.data.pages[0]?.items.length ? (
            <p className="px-4 py-6 text-sm text-slate-500">No upcoming appointments.</p>
          ) : null}
          {listQuery.hasNextPage ? (
            <div className="border-t border-slate-100 p-3 text-center dark:border-slate-800">
              <Button
                variant="ghost"
                loading={listQuery.isFetchingNextPage}
                onClick={() => void listQuery.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          ) : null}
        </Card>
      )}

      <Dialog open={Boolean(open)} onClose={() => setOpen(null)} title={open?.title ?? "Appointment"}>
        {open ? <AppointmentDetail appointment={open} onChanged={(a) => setOpen(a)} /> : null}
      </Dialog>
    </>
  );
}

function AppointmentChip({ a, onOpen }: { a: Appointment; onOpen: () => void }) {
  const inactive = a.status === "CANCELLED" || a.status === "RESCHEDULED";
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "w-full rounded-lg border px-2 py-1.5 text-left text-xs hover:border-brand-500",
        inactive
          ? "border-dashed border-slate-300 text-slate-400 line-through dark:border-slate-700"
          : "border-slate-200 bg-brand-50 dark:border-slate-700 dark:bg-slate-800",
      )}
    >
      <span className="block font-semibold tabular-nums">{localTime(new Date(a.startsAt), a.timezone)}</span>
      <span className="block truncate">{a.lead?.customerName ?? a.title}</span>
      {a.status !== "UPCOMING" ? <span className="sr-only"> ({humanize(a.status)})</span> : null}
    </button>
  );
}
