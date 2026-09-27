"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useMe } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/field";
import { Alert, Card, PageHeader } from "@/components/ui/misc";
import { StatusPill } from "@/components/ui/status-pill";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { fmtDateTime } from "@/lib/format";
import { type Limits, type PlatformBusinessDetail, usd } from "./types";

const LIMIT_FIELDS: { key: keyof Limits; label: string }[] = [
  { key: "maxAgents", label: "Agents" },
  { key: "maxCallsPerDay", label: "Calls a day" },
  { key: "maxCallMinutesPerMonth", label: "Call minutes a month" },
  { key: "maxDocuments", label: "Knowledge documents" },
  { key: "maxStorageMb", label: "Storage (MB)" },
  { key: "maxDocumentSizeMb", label: "Largest document (MB)" },
  { key: "maxLlmTokensPerDay", label: "AI tokens a day" },
];

const ACTION: Record<string, string> = {
  "platform.tenant_suspended": "Suspended",
  "platform.tenant_reactivated": "Reactivated",
  "platform.plan_changed": "Plan or limits changed",
};

/** One business: status, plan and limits, activity and what the platform changed */
export function PlatformBusiness({ id }: { id: string }) {
  const me = useMe();
  const qc = useQueryClient();
  const b = useQuery({
    queryKey: ["platform-tenant", id],
    queryFn: () => api<PlatformBusinessDetail>(`/platform/tenants/${id}`),
  });
  const [suspending, setSuspending] = useState(false);
  const [reason, setReason] = useState("");
  const [plan, setPlan] = useState("");
  const [limits, setLimits] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!b.data) return;
    setPlan(b.data.plan);
    setLimits(Object.fromEntries(LIMIT_FIELDS.map((f) => [f.key, String(b.data.limits[f.key])])));
  }, [b.data]);
  const refresh = (data: PlatformBusinessDetail) => {
    qc.setQueryData(["platform-tenant", id], data);
    void qc.invalidateQueries({ queryKey: ["platform-tenants"] });
  };
  const status = useMutation({
    mutationFn: (body: { status: "ACTIVE" | "SUSPENDED"; reason?: string }) =>
      api<PlatformBusinessDetail>(`/platform/tenants/${id}/status`, { method: "POST", body }),
    onSuccess: (data) => {
      setSuspending(false);
      setReason("");
      refresh(data);
    },
  });
  const save = useMutation({
    mutationFn: () =>
      api<PlatformBusinessDetail>(`/platform/tenants/${id}`, {
        method: "PATCH",
        body: { plan, limits: Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, Number(v)])) },
      }),
    onSuccess: refresh,
  });

  const d = b.data;
  return (
    <>
      <Link
        href={`/t/${me.tenant.slug}/platform`}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-950"
      >
        <ArrowLeft className="size-4" aria-hidden /> Businesses
      </Link>
      {b.isError ? <Alert>{errorMessage(b.error)}</Alert> : null}
      {d ? (
        <>
          <PageHeader
            title={d.name}
            description={`${d.ownerEmail ?? "No owner"} · ${d.country} · since ${fmtDateTime(d.createdAt)}`}
            actions={
              d.status === "ACTIVE" ? (
                <Button variant="danger" onClick={() => setSuspending(true)}>
                  Suspend
                </Button>
              ) : (
                <Button
                  onClick={() => status.mutate({ status: "ACTIVE", reason: "Reactivated" })}
                  loading={status.isPending}
                >
                  Reactivate
                </Button>
              )
            }
          />
          {status.isError && !suspending ? <Alert>{errorMessage(status.error)}</Alert> : null}
          {d.status === "SUSPENDED" ? (
            <div className="mb-6">
              <Alert>
                Suspended {d.statusChangedAt ? fmtDateTime(d.statusChangedAt) : ""}
                {d.statusReason ? `: ${d.statusReason}` : ""}. Calls get &quot;not in service&quot;, WhatsApp
                messages aren&apos;t answered, members can&apos;t sign in and API keys are refused. Nothing is
                deleted.
              </Alert>
            </div>
          ) : null}

          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <h2 className="font-semibold text-slate-950">Plan and limits</h2>
              <p className="mt-0.5 text-sm text-slate-500">
                Limits apply straight away; calls over a limit are refused politely.
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <TextField label="Plan" value={plan} onChange={(e) => setPlan(e.target.value)} />
                {LIMIT_FIELDS.map((f) => (
                  <TextField
                    key={f.key}
                    label={f.label}
                    type="number"
                    min={0}
                    value={limits[f.key] ?? ""}
                    onChange={(e) => setLimits({ ...limits, [f.key]: e.target.value })}
                  />
                ))}
              </div>
              {save.isError ? (
                <div className="mt-3">
                  <Alert>{errorMessage(save.error)}</Alert>
                </div>
              ) : null}
              <div className="mt-5 flex justify-end">
                <Button onClick={() => save.mutate()} loading={save.isPending}>
                  Save plan and limits
                </Button>
              </div>
            </Card>

            <Card>
              <h2 className="font-semibold text-slate-950">Last 30 days</h2>
              <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
                <dt className="text-slate-500">Status</dt>
                <dd>
                  <StatusPill value={d.status} />
                </dd>
                <dt className="text-slate-500">Calls</dt>
                <dd className="tabular-nums">{d.calls30d.toLocaleString()}</dd>
                <dt className="text-slate-500">Minutes</dt>
                <dd className="tabular-nums">{d.minutes30d.toLocaleString()}</dd>
                <dt className="text-slate-500">Cost (estimate)</dt>
                <dd className="tabular-nums">{usd(d.costMicros30d)}</dd>
                <dt className="text-slate-500">Failed jobs</dt>
                <dd className="tabular-nums">{d.failedJobs}</dd>
                <dt className="text-slate-500">Members</dt>
                <dd className="tabular-nums">{d.members}</dd>
                <dt className="text-slate-500">Agents</dt>
                <dd className="tabular-nums">{d.agents}</dd>
                <dt className="text-slate-500">Phone numbers</dt>
                <dd className="tabular-nums">{d.phoneNumbers}</dd>
                <dt className="text-slate-500">WhatsApp numbers</dt>
                <dd className="tabular-nums">{d.whatsappNumbers}</dd>
                <dt className="text-slate-500">Last call</dt>
                <dd>{d.lastCallAt ? fmtDateTime(d.lastCallAt) : "—"}</dd>
              </dl>
            </Card>
          </div>

          <Card className="mt-6">
            <h2 className="font-semibold text-slate-950">Platform changes</h2>
            {d.history.length ? (
              <ul className="mt-3 divide-y divide-slate-100 text-sm">
                {d.history.map((h, i) => (
                  <li key={i} className="flex flex-wrap justify-between gap-2 py-2">
                    <span>
                      <span className="font-medium text-slate-900">{ACTION[h.action] ?? h.action}</span>
                      {(h.after as { reason?: string } | null)?.reason ? (
                        <span className="text-slate-500">: {(h.after as { reason: string }).reason}</span>
                      ) : null}
                    </span>
                    <span className="text-slate-500">
                      {h.by} · {fmtDateTime(h.at)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-slate-500">Nothing changed by the platform yet.</p>
            )}
          </Card>
        </>
      ) : b.isLoading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : null}

      <Dialog open={suspending} onClose={() => setSuspending(false)} title={`Suspend ${d?.name ?? ""}?`}>
        <p className="text-sm text-slate-600">
          Calls to its numbers get &quot;not in service&quot;, WhatsApp messages aren&apos;t answered, members
          can&apos;t sign in and its API keys stop working. Queued work is dropped. Nothing is deleted, and
          you can reactivate it at any time.
        </p>
        <div className="mt-4">
          <TextField
            label="Reason (for the platform team)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Unpaid invoice INV-104"
          />
        </div>
        {status.isError ? (
          <div className="mt-3">
            <Alert>{errorMessage(status.error)}</Alert>
          </div>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setSuspending(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => status.mutate({ status: "SUSPENDED", reason })}
            loading={status.isPending}
            disabled={reason.trim().length < 3}
          >
            Suspend
          </Button>
        </div>
      </Dialog>
    </>
  );
}
