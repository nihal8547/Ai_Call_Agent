"use client";

import { CALL_OUTCOMES, CALL_STATUSES } from "@platform/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMe } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/field";
import { Alert, Card, PageHeader } from "@/components/ui/misc";
import { StatusPill } from "@/components/ui/status-pill";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { fmtDateTime, fmtDuration, humanize } from "@/lib/format";
import type { CallListItem, Page } from "@/lib/types";

export function CallsPage() {
  const me = useMe();
  const router = useRouter();
  const params = useSearchParams();
  const status = params.get("status") ?? "";
  const outcome = params.get("outcome") ?? "";
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(`?${next.toString()}`);
  };

  const calls = useInfiniteQuery({
    queryKey: ["calls", status, outcome],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({
        limit: "50",
        ...(pageParam ? { cursor: pageParam } : {}),
        ...(status ? { status } : {}),
        ...(outcome ? { outcome } : {}),
      });
      return api<Page<CallListItem>>(`/calls?${q}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = calls.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader title="Calls" description="Every call your agents handled, newest first." />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:max-w-xl">
        <SelectField label="Status" value={status} onChange={(e) => setFilter("status", e.target.value)}>
          <option value="">All statuses</option>
          {CALL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {humanize(s)}
            </option>
          ))}
        </SelectField>
        <SelectField label="Outcome" value={outcome} onChange={(e) => setFilter("outcome", e.target.value)}>
          <option value="">All outcomes</option>
          {CALL_OUTCOMES.map((s) => (
            <option key={s} value={s}>
              {humanize(s)}
            </option>
          ))}
        </SelectField>
      </div>
      {calls.error ? <Alert>{errorMessage(calls.error)}</Alert> : null}
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs text-slate-500 uppercase dark:border-slate-800">
            <tr>
              <th className="px-4 py-3 font-medium">Caller</th>
              <th className="px-4 py-3 font-medium">When</th>
              <th className="hidden px-4 py-3 font-medium md:table-cell">Agent</th>
              <th className="hidden px-4 py-3 font-medium sm:table-cell">Duration</th>
              <th className="px-4 py-3 font-medium">Outcome</th>
              <th className="hidden px-4 py-3 font-medium lg:table-cell">Qualification</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr
                key={c.id}
                className="border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50"
              >
                <td className="px-4 py-3">
                  <Link href={`/t/${me.tenant.slug}/calls/${c.id}`} className="font-medium hover:underline">
                    {c.fromNumber}
                  </Link>
                  {c.status === "IN_PROGRESS" ? <StatusPill value="IN_PROGRESS" className="ml-2" /> : null}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-slate-500">{fmtDateTime(c.startedAt)}</td>
                <td className="hidden px-4 py-3 md:table-cell">{c.agent.name}</td>
                <td className="hidden px-4 py-3 tabular-nums sm:table-cell">{fmtDuration(c.durationSec)}</td>
                <td className="px-4 py-3">
                  <StatusPill value={c.outcome} />
                </td>
                <td className="hidden px-4 py-3 lg:table-cell">
                  <StatusPill value={c.qualificationStatus} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {calls.isLoading ? <p className="p-6 text-sm text-slate-500">Loading…</p> : null}
        {calls.data && !rows.length ? (
          <p className="p-6 text-sm text-slate-500">No calls match these filters.</p>
        ) : null}
      </Card>
      {calls.hasNextPage ? (
        <div className="mt-4 text-center">
          <Button
            variant="secondary"
            loading={calls.isFetchingNextPage}
            onClick={() => void calls.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}
