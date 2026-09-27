"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCan } from "@/components/app/me-context";
import { api } from "@/lib/api/client";
import { fmtDateTime } from "@/lib/format";
import type { TenantAlert } from "@/lib/types";

const KIND_LABELS: Record<string, string> = {
  usage_limit: "Plan limit reached",
  call_spike: "Unusual call volume",
  sip_trunk_silent: "SIP connection quiet",
};

/** Open alerts about the business (limits, unusual volume, a silent SIP line) */
export function AlertsBanner() {
  const canRead = useCan("tenant:read");
  const canDismiss = useCan("tenant:write");
  const qc = useQueryClient();
  const alerts = useQuery({
    queryKey: ["alerts"],
    queryFn: () => api<{ items: TenantAlert[] }>("/alerts?open=1"),
    enabled: canRead,
    refetchInterval: 60_000,
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => api(`/alerts/${id}/acknowledge`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });
  const items = alerts.data?.items ?? [];
  if (!items.length) return null;

  return (
    <section aria-label="Alerts" className="mb-6 space-y-2">
      {items.map((a) => (
        <div
          key={a.id}
          role="status"
          className="flex flex-wrap items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          <span aria-hidden className="mt-0.5">
            ⚠
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium">{KIND_LABELS[a.kind] ?? "Attention needed"}</p>
            <p>{a.message}</p>
            <p className="text-xs opacity-75">{fmtDateTime(a.createdAt)}</p>
          </div>
          {canDismiss ? (
            <button
              type="button"
              onClick={() => dismiss.mutate(a.id)}
              className="rounded-md px-2 py-1 font-medium hover:bg-amber-100 dark:hover:bg-amber-900"
            >
              Dismiss
            </button>
          ) : null}
        </div>
      ))}
    </section>
  );
}
