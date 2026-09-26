"use client";

import { type Change, diffJson } from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useCan } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/ui/inputs";
import { Alert } from "@/components/ui/misc";
import { StatusPill } from "@/components/ui/status-pill";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { fmtDateTime } from "@/lib/format";
import type { AgentVersionView } from "@/lib/types";
import { useDraft } from "./draft-context";

type VersionRow = {
  id: string;
  version: number;
  status: string;
  changeNote: string | null;
  createdAt: string;
  publishedAt: string | null;
};

const show = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > 140 ? `${s.slice(0, 140)}…` : (s ?? "—");
};

export function VersionsTab() {
  const { agent, config, dirty, reload } = useDraft();
  const canWrite = useCan("agents:write");
  const qc = useQueryClient();
  const versions = useQuery({
    queryKey: ["agent-versions", agent.id],
    queryFn: () => api<{ items: VersionRow[] }>(`/agents/${agent.id}/versions`),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: ["agent-version", selected],
    queryFn: () => api<AgentVersionView>(`/agents/${agent.id}/versions/${selected}`),
    enabled: Boolean(selected),
  });
  const restore = useMutation({
    mutationFn: (versionId: string) =>
      api(`/agents/${agent.id}/versions/${versionId}/restore`, { method: "POST" }),
    onSuccess: async () => {
      await reload();
      await qc.invalidateQueries({ queryKey: ["agent-versions", agent.id] });
    },
  });

  // Compare the chosen version with what is in the editor now
  const changes: Change[] = detail.data ? diffJson(detail.data.config, config) : [];

  return (
    <Section
      title="Version history"
      description="Every save goes to the draft; publishing makes a version live. Calls in progress keep the version they started with."
    >
      {restore.error ? <Alert>{errorMessage(restore.error)}</Alert> : null}
      {restore.isSuccess ? (
        <Alert tone="success">Restored into the draft. Review it, then publish to roll back.</Alert>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <ul className="space-y-2">
          {versions.data?.items.map((v) => (
            <li key={v.id}>
              <button
                onClick={() => setSelected(v.id)}
                aria-pressed={selected === v.id}
                className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${selected === v.id ? "border-brand-500 bg-brand-50 dark:bg-slate-800" : "border-slate-200 dark:border-slate-800"}`}
              >
                <span className="flex items-center justify-between">
                  <span className="font-medium">Version {v.version}</span>
                  <StatusPill value={v.status} />
                </span>
                <span className="block text-xs text-slate-500">{v.changeNote ?? "No note"}</span>
                <span className="block text-xs text-slate-500">
                  {fmtDateTime(v.publishedAt ?? v.createdAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div>
          {!selected ? (
            <p className="text-sm text-slate-500">Choose a version to compare it with the editor.</p>
          ) : null}
          {detail.data ? (
            <>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm">
                  <strong>{changes.length}</strong> difference{changes.length === 1 ? "" : "s"} between
                  version {detail.data.version} and the editor
                </p>
                {canWrite && detail.data.status !== "DRAFT" ? (
                  <Button
                    variant="secondary"
                    loading={restore.isPending}
                    disabled={dirty}
                    title={dirty ? "Save or discard your changes first" : undefined}
                    onClick={() => restore.mutate(detail.data!.id)}
                  >
                    Restore this version
                  </Button>
                ) : null}
              </div>
              <ul className="space-y-2 text-sm">
                {changes.map((c) => (
                  <li
                    key={c.path + c.kind}
                    className="rounded-lg border border-slate-200 p-2 dark:border-slate-800"
                  >
                    <code className="text-xs">{c.path}</code>{" "}
                    <span className="text-xs text-slate-500">{c.kind}</span>
                    {c.kind !== "added" ? (
                      <p className="mt-1 text-red-700 line-through dark:text-red-300">{show(c.before)}</p>
                    ) : null}
                    {c.kind !== "removed" ? (
                      <p className="mt-1 text-green-700 dark:text-green-300">{show(c.after)}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </div>
    </Section>
  );
}
