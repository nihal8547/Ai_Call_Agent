"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useMe } from "@/components/app/me-context";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { fmtDateTime, plural } from "@/lib/format";
import type { Lead, LeadStatus, Page } from "@/lib/types";

/** One column per lead status (the pipeline); move a lead by choosing its new column */
export function LeadsBoard({
  statuses,
  search,
  canWrite,
}: {
  statuses: LeadStatus[];
  search: string;
  canWrite: boolean;
}) {
  const qc = useQueryClient();
  const move = useMutation({
    mutationFn: ({ id, statusId }: { id: string; statusId: string }) =>
      api(`/leads/${id}`, { method: "PATCH", body: { statusId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["leads"] }),
  });
  return (
    <>
      {move.error ? <p className="mb-2 text-sm text-red-600">{errorMessage(move.error)}</p> : null}
      <div className="-mx-4 overflow-x-auto px-4 pb-2">
        <div className="flex min-w-max gap-3">
          {statuses.map((s) => (
            <Column
              key={s.id}
              status={s}
              statuses={statuses}
              search={search}
              canWrite={canWrite}
              onMove={(id, statusId) => move.mutate({ id, statusId })}
            />
          ))}
        </div>
      </div>
    </>
  );
}

function Column({
  status,
  statuses,
  search,
  canWrite,
  onMove,
}: {
  status: LeadStatus;
  statuses: LeadStatus[];
  search: string;
  canWrite: boolean;
  onMove: (leadId: string, statusId: string) => void;
}) {
  const me = useMe();
  const leads = useQuery({
    queryKey: ["leads", "board", status.id, search],
    queryFn: () =>
      api<Page<Lead>>(
        `/leads?${new URLSearchParams({ statusId: status.id, limit: "50", ...(search.length >= 2 ? { q: search } : {}) })}`,
      ),
  });
  const items = leads.data?.items ?? [];
  return (
    <section
      aria-label={status.label}
      className="w-72 shrink-0 rounded-2xl border border-slate-200 bg-slate-50 p-2 dark:border-slate-800 dark:bg-slate-900/60"
    >
      <h2 className="flex items-center gap-2 px-1 pb-2 text-sm font-semibold">
        <span className="size-2.5 rounded-full" style={{ background: status.color }} aria-hidden />
        {status.label}
        <span className="font-normal text-slate-500">
          {leads.data ? (leads.data.nextCursor ? "50+" : items.length) : ""}
        </span>
      </h2>
      <ul className="space-y-2">
        {items.map((l) => (
          <li
            key={l.id}
            className="rounded-xl border border-slate-200 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-900"
          >
            <p className="font-medium">{l.customerName ?? "Unnamed caller"}</p>
            <p className="text-xs text-slate-500">
              {l.phone ?? "—"} · {fmtDateTime(l.createdAt)}
            </p>
            <div className="mt-2 flex items-center justify-between gap-2">
              {l.callId ? (
                <Link
                  href={`/t/${me.tenant.slug}/calls/${l.callId}`}
                  className="text-xs text-brand-600 hover:underline"
                >
                  View call
                </Link>
              ) : (
                <span />
              )}
              {canWrite ? (
                <select
                  aria-label={`Move ${l.customerName ?? "lead"} to`}
                  value={status.id}
                  onChange={(e) => onMove(l.id, e.target.value)}
                  className="h-8 max-w-36 rounded-lg border border-slate-300 bg-white px-1 text-xs dark:border-slate-700 dark:bg-slate-900"
                >
                  {statuses.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {leads.data && !items.length ? <p className="px-1 py-2 text-xs text-slate-400">No leads</p> : null}
      {leads.data?.nextCursor ? (
        <p className="px-1 pt-2 text-xs text-slate-500">
          Showing the latest {plural(50, "lead")}. Use the list to see all.
        </p>
      ) : null}
    </section>
  );
}
