"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { type AuditEntry, fmtDate, type Page } from "./types";

export function AuditLogPage() {
  const log = useInfiniteQuery({
    queryKey: ["audit-logs"],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      api<Page<AuditEntry>>(`/audit-logs?limit=50${pageParam ? `&cursor=${pageParam}` : ""}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = log.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader title="Audit log" description="Every configuration change, newest first." />
      <Card className="overflow-x-auto p-0">
        {log.error ? (
          <div className="p-6">
            <Alert>{errorMessage(log.error)}</Alert>
          </div>
        ) : null}
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs text-slate-500 uppercase dark:border-slate-800">
            <tr>
              <th className="px-4 py-3 font-medium">When</th>
              <th className="px-4 py-3 font-medium">Action</th>
              <th className="px-4 py-3 font-medium">Actor</th>
              <th className="hidden px-4 py-3 font-medium md:table-cell">IP</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                <td className="px-4 py-3 whitespace-nowrap text-slate-500">{fmtDate(e.createdAt)}</td>
                <td className="px-4 py-3">
                  <code className="text-xs">{e.action}</code>
                </td>
                <td className="px-4 py-3">
                  <Badge>{e.actorType}</Badge>
                </td>
                <td className="hidden px-4 py-3 text-slate-500 md:table-cell">{e.ip ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {log.isLoading ? <p className="p-6 text-sm text-slate-500">Loading…</p> : null}
      </Card>
      {log.hasNextPage ? (
        <div className="mt-4 text-center">
          <Button
            variant="secondary"
            loading={log.isFetchingNextPage}
            onClick={() => void log.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}
