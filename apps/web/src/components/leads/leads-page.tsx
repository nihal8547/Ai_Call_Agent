"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useCan, useMe } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Alert, Badge, Card, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { fmtDateTime, fmtValue, humanize } from "@/lib/format";
import type { Lead, LeadStatus, Page } from "@/lib/types";

export function LeadsPage() {
  const me = useMe();
  const canWrite = useCan("leads:write");
  const qc = useQueryClient();
  const [statusId, setStatusId] = useState("");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const statuses = useQuery({
    queryKey: ["lead-statuses"],
    queryFn: () => api<{ items: LeadStatus[] }>("/lead-statuses"),
  });
  const leads = useInfiniteQuery({
    queryKey: ["leads", statusId, search],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({
        limit: "50",
        ...(pageParam ? { cursor: pageParam } : {}),
        ...(statusId ? { statusId } : {}),
        ...(search.length >= 2 ? { q: search } : {}),
      });
      return api<Page<Lead>>(`/leads?${p}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const setStatus = useMutation({
    mutationFn: ({ id, statusId: s }: { id: string; statusId: string }) =>
      api(`/leads/${id}`, { method: "PATCH", body: { statusId: s } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["leads"] }),
  });
  const rows = leads.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader title="Leads" description="People your agents spoke to, with the details they gave." />
      <form
        className="mb-4 grid gap-3 sm:grid-cols-[1fr_220px_auto] sm:items-end lg:max-w-3xl"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(q.trim());
        }}
      >
        <TextField
          label="Search"
          placeholder="Name, phone or email"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <SelectField label="Status" value={statusId} onChange={(e) => setStatusId(e.target.value)}>
          <option value="">All statuses</option>
          {statuses.data?.items.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </SelectField>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      {leads.error ? <Alert>{errorMessage(leads.error)}</Alert> : null}
      {setStatus.error ? <Alert>{errorMessage(setStatus.error)}</Alert> : null}
      <div className="space-y-3">
        {rows.map((l) => (
          <Card key={l.id} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-semibold">{l.customerName ?? "Unnamed caller"}</p>
                <p className="text-sm text-slate-500">
                  {l.phone ?? "—"}
                  {l.email ? ` · ${l.email}` : ""} · {fmtDateTime(l.createdAt)}
                  {l.agent ? ` · ${l.agent.name}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="size-2.5 rounded-full" style={{ background: l.status.color }} aria-hidden />
                {canWrite && statuses.data ? (
                  <select
                    aria-label={`Status of ${l.customerName ?? "lead"}`}
                    value={l.status.id}
                    onChange={(e) => setStatus.mutate({ id: l.id, statusId: e.target.value })}
                    className="h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                  >
                    {statuses.data.items.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Badge>{l.status.label}</Badge>
                )}
              </div>
            </div>
            {Object.keys(l.data).length ? (
              <dl className="mt-3 flex flex-wrap gap-2 text-sm">
                {Object.entries(l.data).map(([k, v]) => (
                  <div key={k} className="rounded-lg bg-slate-100 px-2 py-1 dark:bg-slate-800">
                    <dt className="inline text-slate-500">{humanize(k)}: </dt>
                    <dd className="inline font-medium">{fmtValue(v)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {l.callId ? (
              <Link
                href={`/t/${me.tenant.slug}/calls/${l.callId}`}
                className="mt-3 inline-block text-sm text-brand-600 hover:underline"
              >
                View call
              </Link>
            ) : null}
          </Card>
        ))}
      </div>
      {leads.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {leads.data && !rows.length ? (
        <Card>
          <p className="text-sm text-slate-500">No leads yet.</p>
        </Card>
      ) : null}
      {leads.hasNextPage ? (
        <div className="mt-4 text-center">
          <Button
            variant="secondary"
            loading={leads.isFetchingNextPage}
            onClick={() => void leads.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}
