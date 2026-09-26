"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useCan, useMe } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { fmtDateTime, plural } from "@/lib/format";

type FailedJob = {
  id: string;
  queue: "webhooks" | "notifications" | "crm";
  label: string;
  error: string;
  attempts: number;
  status: "FAILED" | "RETRIED" | "DISMISSED";
  callId: string | null;
  leadId: string | null;
  integrationId: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

const QUEUE_LABEL: Record<FailedJob["queue"], string> = {
  webhooks: "Webhook",
  notifications: "Email",
  crm: "CRM / records",
};
const TABS = [
  { status: "FAILED", label: "Needs attention" },
  { status: "RETRIED", label: "Sent again" },
  { status: "DISMISSED", label: "Dismissed" },
] as const;

/**
 * Background deliveries (webhooks, staff emails, CRM syncs) that failed after every retry.
 * Fix the cause (a URL, a password, a revoked token), then send them again.
 */
export function FailedJobsPage() {
  const me = useMe();
  const qc = useQueryClient();
  const canWrite = useCan("integrations:write");
  const [status, setStatus] = useState<FailedJob["status"]>("FAILED");
  const jobs = useQuery({
    queryKey: ["failed-jobs", status],
    queryFn: () => api<{ items: FailedJob[]; open: number }>(`/jobs/failed?status=${status}&limit=100`),
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "retry" | "dismiss" }) =>
      api(`/jobs/failed/${id}/${action}`, { method: "POST" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["failed-jobs"] });
      await qc.invalidateQueries({ queryKey: ["failed-jobs-count"] });
    },
  });
  const base = `/t/${me.tenant.slug}`;

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={`${base}/integrations`} className="text-slate-500 hover:underline">
          ← Integrations
        </Link>
      </p>
      <PageHeader
        title="Failed deliveries"
        description="Webhooks, emails and CRM syncs are retried automatically with increasing waits. These still failed. Fix the cause, then send them again."
      />
      <div className="mb-4 flex flex-wrap gap-1" role="tablist" aria-label="Show">
        {TABS.map((t) => (
          <button
            key={t.status}
            type="button"
            role="tab"
            aria-selected={status === t.status}
            onClick={() => setStatus(t.status)}
            className={
              status === t.status
                ? "rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white dark:bg-slate-100 dark:text-slate-900"
                : "rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            }
          >
            {t.label}
            {t.status === "FAILED" && jobs.data && status === "FAILED" ? ` (${jobs.data.open})` : ""}
          </button>
        ))}
      </div>
      <div className="space-y-3">
        {jobs.error ? <Alert>{errorMessage(jobs.error)}</Alert> : null}
        {act.error ? <Alert>{errorMessage(act.error)}</Alert> : null}
        {jobs.data && !jobs.data.items.length ? (
          <Card>
            <p className="text-sm text-slate-500">
              {status === "FAILED"
                ? "Nothing needs attention. Every delivery went through."
                : "Nothing here."}
            </p>
          </Card>
        ) : null}
        <ul className="space-y-3">
          {jobs.data?.items.map((j) => (
            <li key={j.id}>
              <Card className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{j.label}</p>
                    <p className="mt-0.5 text-sm text-slate-500">
                      <Badge>{QUEUE_LABEL[j.queue]}</Badge> · {plural(j.attempts, "attempt")} · failed{" "}
                      {fmtDateTime(j.createdAt)}
                      {j.resolvedAt
                        ? ` · ${j.status === "RETRIED" ? "sent again" : "dismissed"} ${fmtDateTime(j.resolvedAt)}`
                        : ""}
                    </p>
                    <p className="mt-2 text-sm break-words text-red-700 dark:text-red-300">{j.error}</p>
                    <p className="mt-2 flex flex-wrap gap-3 text-sm">
                      {j.callId ? (
                        <Link href={`${base}/calls/${j.callId}`} className="text-brand-600 hover:underline">
                          View call
                        </Link>
                      ) : null}
                      {j.integrationId ? (
                        <Link href={`${base}/integrations`} className="text-brand-600 hover:underline">
                          Check the integration
                        </Link>
                      ) : null}
                    </p>
                  </div>
                  {j.status === "FAILED" && canWrite ? (
                    <div className="flex gap-2">
                      <Button
                        variant="secondary"
                        loading={
                          act.isPending && act.variables?.id === j.id && act.variables.action === "retry"
                        }
                        onClick={() => act.mutate({ id: j.id, action: "retry" })}
                      >
                        Send again
                      </Button>
                      <Button
                        variant="ghost"
                        loading={
                          act.isPending && act.variables?.id === j.id && act.variables.action === "dismiss"
                        }
                        onClick={() => act.mutate({ id: j.id, action: "dismiss" })}
                      >
                        Dismiss
                      </Button>
                    </div>
                  ) : (
                    <Badge>
                      {j.status === "RETRIED"
                        ? "Sent again"
                        : j.status === "DISMISSED"
                          ? "Dismissed"
                          : "Failed"}
                    </Badge>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
