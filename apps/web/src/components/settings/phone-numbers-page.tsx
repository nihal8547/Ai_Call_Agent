"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useCan } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Alert, Card, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import type { AgentListItem, PhoneNumber } from "@/lib/types";

export function PhoneNumbersPage() {
  const canWrite = useCan("phone_numbers:write");
  const qc = useQueryClient();
  const numbers = useQuery({
    queryKey: ["phone-numbers"],
    queryFn: () => api<{ items: PhoneNumber[] }>("/phone-numbers"),
  });
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ items: AgentListItem[] }>("/agents"),
    enabled: useCan("agents:read"),
  });
  const [e164, setE164] = useState("");
  const [friendlyName, setFriendlyName] = useState("");
  const [agentId, setAgentId] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["phone-numbers"] });

  const add = useMutation({
    mutationFn: () =>
      api("/phone-numbers", {
        method: "POST",
        body: {
          e164: e164.replace(/\s/g, ""),
          ...(friendlyName ? { friendlyName } : {}),
          agentId: agentId || null,
        },
      }),
    onSuccess: () => {
      setE164("");
      setFriendlyName("");
      void refresh();
    },
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api(`/phone-numbers/${id}`, { method: "PATCH", body }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/phone-numbers/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  const error = add.error ?? patch.error ?? remove.error;

  return (
    <>
      <PageHeader
        title="Phone numbers"
        description="Route each of your numbers to the agent that should answer it."
      />
      {error ? (
        <div className="mb-4">
          <Alert>{errorMessage(error)}</Alert>
        </div>
      ) : null}
      {canWrite ? (
        <Card>
          <h2 className="font-semibold">Add a number</h2>
          <form
            className="mt-4 grid gap-4 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <TextField
              label="Number"
              placeholder="+91 98765 43210"
              value={e164}
              onChange={(e) => setE164(e.target.value)}
              hint="International format with country code"
            />
            <TextField
              label="Label"
              placeholder="Front desk"
              value={friendlyName}
              onChange={(e) => setFriendlyName(e.target.value)}
            />
            <SelectField label="Answered by" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">No agent yet</option>
              {agents.data?.items.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </SelectField>
            <Button type="submit" loading={add.isPending} disabled={!e164.trim()}>
              Add
            </Button>
          </form>
        </Card>
      ) : null}
      <Card className="mt-6">
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {numbers.data?.items.map((n) => (
            <li key={n.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
              <div className="min-w-40">
                <p className="font-medium tabular-nums">{n.e164}</p>
                <p className="text-slate-500">{n.friendlyName ?? "—"}</p>
              </div>
              {canWrite ? (
                <>
                  <select
                    aria-label={`Agent for ${n.e164}`}
                    value={n.agent?.id ?? ""}
                    onChange={(e) => patch.mutate({ id: n.id, body: { agentId: e.target.value || null } })}
                    className="h-9 rounded-lg border border-slate-300 bg-white px-2 dark:border-slate-700 dark:bg-slate-900"
                  >
                    <option value="">No agent</option>
                    {agents.data?.items.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={n.isActive}
                      onChange={(e) => patch.mutate({ id: n.id, body: { isActive: e.target.checked } })}
                    />{" "}
                    Active
                  </label>
                  <Button
                    variant="ghost"
                    className="ml-auto text-red-600"
                    onClick={() => confirm(`Remove ${n.e164}?`) && remove.mutate(n.id)}
                  >
                    Remove
                  </Button>
                </>
              ) : (
                <span className="text-slate-500">{n.agent?.name ?? "No agent"}</span>
              )}
            </li>
          ))}
        </ul>
        {numbers.data && !numbers.data.items.length ? (
          <p className="text-sm text-slate-500">No numbers yet.</p>
        ) : null}
      </Card>
    </>
  );
}
