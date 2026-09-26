"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useCan } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Alert, Card, PageHeader } from "@/components/ui/misc";
import { StatusPill } from "@/components/ui/status-pill";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { fmtDateTime } from "@/lib/format";
import type { Integration } from "@/lib/types";
import { IntegrationForm } from "./integration-form";
import { CATALOG, type ConnectableType, describeConfig } from "./catalog";

type ListResponse = { items: Integration[]; googleOAuth: boolean };

export function IntegrationsPage() {
  const canWrite = useCan("integrations:write");
  const qc = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const list = useQuery({ queryKey: ["integrations"], queryFn: () => api<ListResponse>("/integrations") });
  const [connecting, setConnecting] = useState<ConnectableType | null>(null);
  const [editing, setEditing] = useState<Integration | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; secret: string } | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const refresh = () => qc.invalidateQueries({ queryKey: ["integrations"] });

  const test = useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; message: string }>(`/integrations/${id}/test`, { method: "POST" }),
    onSuccess: (r, id) => {
      setResults((x) => ({ ...x, [id]: r }));
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/integrations/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  // Back from "Connect with Google"
  const oauthError = params.get("error");
  const oauthConnected = params.get("connected");
  const clearOAuth = () => router.replace("?");

  const onSaved = (saved: Integration) => {
    setConnecting(null);
    setEditing(null);
    if (saved.signingSecret) setRevealed({ name: saved.name, secret: saved.signingSecret });
    void refresh();
  };

  const items = list.data?.items ?? [];
  return (
    <>
      <PageHeader
        title="Integrations"
        description="Connect the calendars, sheets, email and systems your agents use. Credentials are encrypted and never shown again."
      />
      <div className="space-y-4">
        {oauthError ? (
          <Alert>
            {oauthError}{" "}
            <button type="button" className="underline" onClick={clearOAuth}>
              Dismiss
            </button>
          </Alert>
        ) : null}
        {oauthConnected ? (
          <Alert tone="success">
            Google is connected. Test it below, then choose it for your agents&apos; tools.{" "}
            <button type="button" className="underline" onClick={clearOAuth}>
              Dismiss
            </button>
          </Alert>
        ) : null}
        {list.error ? <Alert>{errorMessage(list.error)}</Alert> : null}
        {(test.error ?? remove.error) ? <Alert>{errorMessage(test.error ?? remove.error)}</Alert> : null}

        <section aria-labelledby="connected-heading">
          <h2 id="connected-heading" className="mb-3 font-semibold">
            Connected
          </h2>
          {list.data && !items.length ? (
            <Card>
              <p className="text-sm text-slate-500">Nothing connected yet. Pick a service below.</p>
            </Card>
          ) : null}
          <ul className="grid gap-4 lg:grid-cols-2">
            {items.map((i) => {
              const result = results[i.id];
              return (
                <li key={i.id}>
                  <Card className="h-full p-5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold">{i.name}</p>
                        <p className="text-sm text-slate-500">
                          {CATALOG.find((c) => c.type === i.type)?.label ?? i.type}
                        </p>
                      </div>
                      <StatusPill value={i.status} />
                    </div>
                    <p className="mt-3 text-sm break-all text-slate-600 dark:text-slate-300">
                      {describeConfig(i)}
                    </p>
                    {i.status === "ERROR" && i.lastError && !result ? (
                      <p className="mt-2 text-sm text-red-600 dark:text-red-400">{i.lastError}</p>
                    ) : null}
                    {result ? (
                      <p
                        className={
                          result.ok
                            ? "mt-2 text-sm text-green-700 dark:text-green-400"
                            : "mt-2 text-sm text-red-600 dark:text-red-400"
                        }
                      >
                        {result.message}
                      </p>
                    ) : null}
                    <p className="mt-2 text-xs text-slate-500">
                      {i.usedBy.length
                        ? `Used by ${[...new Set(i.usedBy.map((u) => u.agent.name))].join(", ")}`
                        : "Not used by any agent yet"}
                      {i.lastCheckedAt ? ` · checked ${fmtDateTime(i.lastCheckedAt)}` : ""}
                    </p>
                    {canWrite ? (
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button
                          variant="secondary"
                          loading={test.isPending && test.variables === i.id}
                          onClick={() => test.mutate(i.id)}
                        >
                          Test
                        </Button>
                        <Button variant="secondary" onClick={() => setEditing(i)}>
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          className="text-red-600"
                          onClick={() =>
                            confirm(
                              i.usedBy.length
                                ? `Remove "${i.name}"? Agents using it will stop running those tools.`
                                : `Remove "${i.name}"?`,
                            ) && remove.mutate(i.id)
                          }
                        >
                          Remove
                        </Button>
                      </div>
                    ) : null}
                  </Card>
                </li>
              );
            })}
          </ul>
        </section>

        {canWrite ? (
          <section aria-labelledby="add-heading" className="pt-2">
            <h2 id="add-heading" className="mb-3 font-semibold">
              Add an integration
            </h2>
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {CATALOG.map((c) => (
                <li key={c.type}>
                  <Card className="flex h-full flex-col p-5">
                    <p className="font-semibold">{c.label}</p>
                    <p className="mt-1 flex-1 text-sm text-slate-500">{c.description}</p>
                    {c.available ? (
                      <Button
                        variant="secondary"
                        className="mt-4"
                        onClick={() => setConnecting(c.type as ConnectableType)}
                      >
                        Connect
                      </Button>
                    ) : (
                      <p className="mt-4 text-xs font-medium tracking-wide text-slate-400 uppercase">
                        Coming soon
                      </p>
                    )}
                  </Card>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <Dialog
        open={Boolean(connecting)}
        onClose={() => setConnecting(null)}
        title={`Connect ${CATALOG.find((c) => c.type === connecting)?.label ?? ""}`}
      >
        {connecting ? (
          <IntegrationForm
            type={connecting}
            googleOAuth={list.data?.googleOAuth ?? false}
            onSaved={onSaved}
          />
        ) : null}
      </Dialog>
      <Dialog open={Boolean(editing)} onClose={() => setEditing(null)} title={`Edit ${editing?.name ?? ""}`}>
        {editing ? (
          <IntegrationForm
            type={editing.type as ConnectableType}
            existing={editing}
            googleOAuth={list.data?.googleOAuth ?? false}
            onSaved={onSaved}
          />
        ) : null}
      </Dialog>
      <Dialog open={Boolean(revealed)} onClose={() => setRevealed(null)} title="Save your signing secret">
        {revealed ? (
          <div className="space-y-3 text-sm">
            <p>
              Requests to your endpoint carry an <code>x-platform-signature</code> header:{" "}
              <code>t=&lt;timestamp&gt;,v1=&lt;HMAC-SHA256 of &quot;timestamp.body&quot;&gt;</code>. Verify it
              with this secret. It won&apos;t be shown again.
            </p>
            <p className="rounded-lg bg-slate-100 p-3 font-mono text-xs break-all dark:bg-slate-800">
              {revealed.secret}
            </p>
            <Button onClick={() => void navigator.clipboard?.writeText(revealed.secret)}>Copy secret</Button>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
