"use client";

import { PERMISSIONS } from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useCan, useMe } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Alert, Badge, Card, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { type ApiKey, fmtDate } from "./types";

export function ApiKeysPage() {
  const me = useMe();
  const canWrite = useCan("api_keys:write");
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["api-keys"], queryFn: () => api<{ items: ApiKey[] }>("/api-keys") });
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api<{ key: string }>("/api-keys", { method: "POST", body: { name, scopes } }),
    onSuccess: (res) => {
      setCreated(res.key);
      setName("");
      setScopes([]);
      setError(null);
      void qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });

  // You can only grant scopes you hold yourself
  const grantable = PERMISSIONS.filter((p) => me.permissions.includes(p));

  return (
    <>
      <PageHeader title="API keys" description="Let your own systems read and write data in this business." />
      {created ? (
        <div className="mb-4">
          <Alert tone="success">
            Copy this key now — it will not be shown again.
            <input
              readOnly
              value={created}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="New API key"
              className="mt-2 block w-full rounded border border-current/30 bg-transparent px-2 py-1 font-mono text-xs"
            />
          </Alert>
        </div>
      ) : null}

      {canWrite ? (
        <Card>
          <h2 className="font-semibold">Create a key</h2>
          <form
            className="mt-4 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <TextField
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. CRM sync"
            />
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-300">Scopes</legend>
              <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                {grantable.map((p) => (
                  <label key={p} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={scopes.includes(p)}
                      onChange={(e) =>
                        setScopes(e.target.checked ? [...scopes, p] : scopes.filter((s) => s !== p))
                      }
                    />
                    <code className="text-xs">{p}</code>
                  </label>
                ))}
              </div>
            </fieldset>
            {error ? <Alert>{error}</Alert> : null}
            <Button type="submit" loading={create.isPending} disabled={!name.trim() || !scopes.length}>
              Create key
            </Button>
          </form>
        </Card>
      ) : null}

      <Card className="mt-6">
        {keys.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
        {keys.data && !keys.data.items.length ? (
          <p className="text-sm text-slate-500">No API keys yet.</p>
        ) : null}
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {keys.data?.items.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <div>
                <p className="font-medium">
                  {k.name} <code className="ml-1 text-xs text-slate-500">{k.prefix}…</code>{" "}
                  {k.revokedAt ? <Badge>revoked</Badge> : null}
                </p>
                <p className="text-slate-500">
                  Created {fmtDate(k.createdAt)} · last used {fmtDate(k.lastUsedAt)}
                </p>
                <p className="mt-1 flex flex-wrap gap-1">
                  {k.scopes.map((s) => (
                    <Badge key={s}>{s}</Badge>
                  ))}
                </p>
              </div>
              {canWrite && !k.revokedAt ? (
                <Button
                  variant="danger"
                  onClick={() =>
                    confirm(`Revoke "${k.name}"? Systems using it will stop working.`) && revoke.mutate(k.id)
                  }
                >
                  Revoke
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
