"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useCan, useMe } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Alert, Card, PageHeader } from "@/components/ui/misc";
import { StatusPill } from "@/components/ui/status-pill";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import type { AgentListItem, Template } from "@/lib/types";

export function AgentsPage() {
  const me = useMe();
  const canWrite = useCan("agents:write");
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ items: AgentListItem[] }>("/agents"),
  });
  const toggle = useMutation({
    mutationFn: (a: AgentListItem) =>
      api(`/agents/${a.id}/status`, {
        method: "POST",
        body: { status: a.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });

  return (
    <>
      <PageHeader
        title="AI agents"
        description="Each agent answers calls for one purpose, with its own questions, rules and knowledge."
        actions={canWrite ? <Button onClick={() => setCreating(true)}>New agent</Button> : null}
      />
      {creating ? <NewAgent onClose={() => setCreating(false)} /> : null}
      {agents.error ? <Alert>{errorMessage(agents.error)}</Alert> : null}
      {toggle.error ? <Alert>{errorMessage(toggle.error)}</Alert> : null}
      {agents.data && !agents.data.items.length ? (
        <Card>
          <p className="text-sm text-slate-500">No agents yet. Create one from a template to get started.</p>
        </Card>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        {agents.data?.items.map((a) => (
          <Card key={a.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Link href={`/t/${me.tenant.slug}/agents/${a.id}`} className="font-semibold hover:underline">
                  {a.name}
                </Link>
                <p className="mt-0.5 truncate text-sm text-slate-500">
                  {a.description ?? a.templateKey ?? "Custom agent"}
                </p>
              </div>
              <StatusPill value={a.status} />
            </div>
            <dl className="mt-4 grid grid-cols-3 gap-2 text-sm">
              <div>
                <dt className="text-slate-500">Live version</dt>
                <dd>{a.publishedVersion ? `v${a.publishedVersion.version}` : "Not published"}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Numbers</dt>
                <dd>{a.phoneNumbers.length || "None"}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Calls</dt>
                <dd>{a.calls}</dd>
              </div>
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                href={`/t/${me.tenant.slug}/agents/${a.id}`}
                className="inline-flex h-10 items-center rounded-lg border border-slate-300 px-4 text-sm font-medium dark:border-slate-700"
              >
                {a.hasDraft ? "Continue editing" : "Edit"}
              </Link>
              {canWrite && a.publishedVersion ? (
                <Button
                  variant="ghost"
                  loading={toggle.isPending && toggle.variables?.id === a.id}
                  onClick={() => toggle.mutate(a)}
                >
                  {a.status === "ACTIVE" ? "Deactivate" : "Activate"}
                </Button>
              ) : null}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

function NewAgent({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const router = useRouter();
  const templates = useQuery({
    queryKey: ["agent-templates"],
    queryFn: () => api<{ items: Template[] }>("/agent-templates"),
  });
  const [templateKey, setTemplateKey] = useState("");
  const [name, setName] = useState("");
  const [agentName, setAgentName] = useState("");
  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>("/agents", {
        method: "POST",
        body: { name, templateKey, ...(agentName.trim() ? { agentName: agentName.trim() } : {}) },
      }),
    onSuccess: (r) => router.push(`/t/${me.tenant.slug}/agents/${r.id}`),
  });
  const chosen = templates.data?.items.find((t) => t.key === templateKey);

  return (
    <Card className="mb-6">
      <h2 className="font-semibold">Create an agent</h2>
      <form
        className="mt-4 grid gap-4 md:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <SelectField
          label="Start from"
          value={templateKey}
          onChange={(e) => setTemplateKey(e.target.value)}
          required
        >
          <option value="" disabled>
            Choose a template…
          </option>
          {templates.data?.items.map((t) => (
            <option key={t.key} value={t.key}>
              {t.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Agent name (internal)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Sales line"
          required
          minLength={2}
        />
        <TextField
          label="Introduces itself as"
          value={agentName}
          onChange={(e) => setAgentName(e.target.value)}
          placeholder="e.g. Ava"
        />
        {chosen ? <p className="text-sm text-slate-500 md:col-span-3">{chosen.description}</p> : null}
        {create.error ? (
          <div className="md:col-span-3">
            <Alert>{errorMessage(create.error)}</Alert>
          </div>
        ) : null}
        <div className="flex gap-2 md:col-span-3">
          <Button type="submit" loading={create.isPending} disabled={!templateKey || name.trim().length < 2}>
            Create draft
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
