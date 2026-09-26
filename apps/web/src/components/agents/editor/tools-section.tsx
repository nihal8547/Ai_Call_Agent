"use client";

import { TOOL_NAMES, TOOL_SPECS, type ToolName } from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useCan, useMe } from "@/components/app/me-context";
import { INTEGRATION_LABEL } from "@/components/integrations/catalog";
import { Check, Section } from "@/components/ui/inputs";
import { StatusPill } from "@/components/ui/status-pill";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import type { Integration, ToolBinding } from "@/lib/types";
import { useDraft } from "./draft-context";

/**
 * Tool permissions (part of the versioned config) and, for tools that run through an
 * integration, which one this agent uses (saved immediately, like phone numbers).
 */
export function ToolsSection() {
  const me = useMe();
  const qc = useQueryClient();
  const { agent, config, update, errorFor } = useDraft();
  const canWrite = useCan("agents:write");
  const canSeeIntegrations = useCan("integrations:read");
  const integrations = useQuery({
    queryKey: ["integrations"],
    queryFn: () => api<{ items: Integration[] }>("/integrations"),
    enabled: canSeeIntegrations,
  });
  const bindings = useQuery({
    queryKey: ["tool-bindings", agent.id],
    queryFn: () => api<{ items: ToolBinding[] }>(`/agents/${agent.id}/tool-bindings`),
  });
  const save = useMutation({
    mutationFn: (b: { toolName: ToolName; integrationId: string | null }) =>
      api<{ items: ToolBinding[] }>(`/agents/${agent.id}/tool-bindings`, {
        method: "PUT",
        body: { bindings: [b] },
      }),
    onSuccess: (data) => {
      qc.setQueryData(["tool-bindings", agent.id], data);
      void qc.invalidateQueries({ queryKey: ["integrations"] });
    },
  });
  const boundTo = (t: ToolName) => bindings.data?.items.find((b) => b.toolName === t)?.integration ?? null;
  const toolIndex = (t: ToolName) => config.tools.indexOf(t);

  return (
    <Section
      title="Tools"
      description="Actions this agent may perform. Anything not ticked can never run, whatever the conversation."
    >
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {TOOL_NAMES.map((t) => {
          const spec = TOOL_SPECS[t];
          const enabled = config.tools.includes(t);
          const bound = boundTo(t);
          const choices = (integrations.data?.items ?? []).filter((i) => i.type === spec.integration);
          const problem = enabled ? errorFor(`tools.${toolIndex(t)}`) : undefined;
          return (
            <li key={t} className="flex flex-wrap items-start gap-x-6 gap-y-2 py-3">
              <div className="min-w-60 flex-1">
                <Check
                  label={
                    <>
                      <span className="font-medium">{spec.label}</span>
                      {!spec.available ? (
                        <span className="ml-2 text-xs text-slate-400 uppercase">coming soon</span>
                      ) : null}
                    </>
                  }
                  hint={spec.description}
                  checked={enabled}
                  onChange={(v) =>
                    update((c) => void (c.tools = v ? [...c.tools, t] : c.tools.filter((x) => x !== t)))
                  }
                />
                {problem ? (
                  <p className="mt-1 ml-6 text-sm text-red-600 dark:text-red-400">{problem}</p>
                ) : null}
              </div>
              {spec.integration && spec.available && enabled ? (
                <div className="flex min-w-60 flex-wrap items-center gap-2 text-sm">
                  {canSeeIntegrations ? (
                    choices.length ? (
                      <>
                        <label className="sr-only" htmlFor={`bind-${t}`}>
                          {`${INTEGRATION_LABEL[spec.integration] ?? spec.integration} for ${spec.label}`}
                        </label>
                        <select
                          id={`bind-${t}`}
                          value={bound?.id ?? ""}
                          disabled={!canWrite || save.isPending}
                          onChange={(e) =>
                            save.mutate({ toolName: t, integrationId: e.target.value || null })
                          }
                          className="h-9 rounded-lg border border-slate-300 bg-white px-2 dark:border-slate-700 dark:bg-slate-900"
                        >
                          <option value="">Choose {INTEGRATION_LABEL[spec.integration]}…</option>
                          {choices.map((i) => (
                            <option key={i.id} value={i.id}>
                              {i.name}
                            </option>
                          ))}
                        </select>
                        {bound ? <StatusPill value={bound.status} /> : null}
                      </>
                    ) : (
                      <span className="text-amber-700 dark:text-amber-300">
                        Needs {INTEGRATION_LABEL[spec.integration]}.{" "}
                        <Link href={`/t/${me.tenant.slug}/integrations`} className="underline">
                          Connect one
                        </Link>
                      </span>
                    )
                  ) : (
                    <span className="text-slate-500">
                      {bound ? `Uses ${bound.name}` : "No integration chosen"}
                    </span>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {save.error ? <p className="mt-2 text-sm text-red-600">{errorMessage(save.error)}</p> : null}
      {errorFor("tools") ? <p className="mt-2 text-sm text-red-600">{errorFor("tools")}</p> : null}
      <p className="mt-3 text-xs text-slate-500">
        Integration choices apply immediately to live calls. Tool permissions apply when you publish.
      </p>
    </Section>
  );
}
