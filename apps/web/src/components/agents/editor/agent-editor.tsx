"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useCan, useMe } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { Alert, PageHeader } from "@/components/ui/misc";
import { StatusPill } from "@/components/ui/status-pill";
import { api } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { cn } from "@/lib/cn";
import { DraftProvider, useDraft } from "./draft-context";
import { HoursTab } from "./tab-hours";
import { KnowledgeTab } from "./tab-knowledge";
import { ProfileTab } from "./tab-profile";
import { QuestionsTab } from "./tab-questions";
import { TestTab } from "./tab-test";
import { VersionsTab } from "./tab-versions";
import { WorkflowTab } from "./tab-workflow";

const TABS = [
  {
    key: "profile",
    label: "Profile",
    prefixes: [
      "businessName",
      "agentName",
      "greeting",
      "disclosure",
      "language",
      "voice",
      "persona",
      "instructions",
      "businessRules",
      "llm",
    ],
  },
  { key: "questions", label: "Questions", prefixes: ["qualificationFields"] },
  { key: "workflow", label: "Workflow & tools", prefixes: ["workflow", "tools"] },
  { key: "knowledge", label: "Knowledge", prefixes: ["knowledge"] },
  {
    key: "hours",
    label: "Hours, bookings & handoff",
    prefixes: ["workingHours", "handoff", "appointment", "escalation", "limits", "messages"],
  },
  { key: "versions", label: "Versions", prefixes: [] },
  { key: "test", label: "Test", prefixes: [] },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function AgentEditor({ id }: { id: string }) {
  return (
    <DraftProvider id={id}>
      {(ctx, error) =>
        error ? (
          <Alert>{errorMessage(error)}</Alert>
        ) : ctx ? (
          <Editor />
        ) : (
          <p className="text-sm text-slate-500">Loading…</p>
        )
      }
    </DraftProvider>
  );
}

function Editor() {
  const me = useMe();
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = (TABS.find((t) => t.key === params.get("tab"))?.key ?? "profile") as TabKey;
  const { agent, dirty, localErrors, serverErrors, save, saving } = useDraft();
  const canWrite = useCan("agents:write");
  const canPublish = useCan("agents:publish");
  const [notice, setNotice] = useState<string | null>(null);

  const publish = useMutation({
    mutationFn: () => api<{ version: number }>(`/agents/${agent.id}/publish`, { method: "POST" }),
    onSuccess: async (v) => {
      setNotice(
        `Version ${v.version} is live. New calls use it now; calls in progress finish on their version.`,
      );
      await qc.invalidateQueries({ queryKey: ["agent", agent.id] });
      await qc.invalidateQueries({ queryKey: ["agent-versions", agent.id] });
      await qc.invalidateQueries({ queryKey: ["agents"] });
    },
  });
  const publishErrors = publish.error instanceof ApiError ? publish.error.fieldErrors : [];
  const problems = [...localErrors, ...serverErrors, ...publishErrors];
  const countFor = (prefixes: readonly string[]) =>
    problems.filter((e) => prefixes.some((p) => e.path.startsWith(`config.${p}`))).length;

  return (
    <>
      <PageHeader
        title={agent.name}
        description={
          agent.published
            ? `Live: version ${agent.published.version}${agent.draft ? ` · draft v${agent.draft.version}` : ""}`
            : "Not published yet"
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill value={agent.status} />
            {dirty ? (
              <span className="text-sm text-amber-700 dark:text-amber-300">Unsaved changes</span>
            ) : null}
            {canWrite ? (
              <Button
                variant="secondary"
                loading={saving}
                disabled={!dirty || localErrors.length > 0}
                title={localErrors.length ? "Fix the problems first" : undefined}
                onClick={async () => {
                  setNotice(null);
                  if (await save()) setNotice("Draft saved. Test it, then publish to use it on calls.");
                }}
              >
                Save draft
              </Button>
            ) : null}
            {canPublish ? (
              <Button
                loading={publish.isPending}
                disabled={dirty || !agent.draft}
                title={
                  dirty ? "Save your changes first" : !agent.draft ? "Nothing new to publish" : undefined
                }
                onClick={() => publish.mutate()}
              >
                Publish
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="mb-4 space-y-2">
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {publish.error && !publishErrors.length ? <Alert>{errorMessage(publish.error)}</Alert> : null}
        {problems.length ? (
          <Alert>
            {problems.length} problem{problems.length === 1 ? "" : "s"} to fix:
            <ul className="mt-1 list-disc pl-5">
              {problems.slice(0, 8).map((e) => (
                <li key={e.path + e.message}>
                  <code className="text-xs">{e.path.replace(/^config\./, "")}</code>: {e.message}
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}
        {!agent.phoneNumbers.length ? (
          <Alert tone="info">
            No phone number routes to this agent yet.{" "}
            <Link className="font-medium underline" href={`/t/${me.tenant.slug}/settings/phone-numbers`}>
              Connect a number
            </Link>
          </Alert>
        ) : null}
      </div>

      <div
        role="tablist"
        aria-label="Agent settings"
        className="mb-6 flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800"
      >
        {TABS.map((t) => {
          const n = countFor(t.prefixes);
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => router.replace(`${pathname}?tab=${t.key}`, { scroll: false })}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap",
                tab === t.key
                  ? "border-brand-600 text-brand-600"
                  : "border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-300",
              )}
            >
              {t.label}
              {n ? (
                <span className="ml-1.5 rounded-full bg-red-100 px-1.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                  {n}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <fieldset disabled={!canWrite && tab !== "test" && tab !== "versions"} role="tabpanel">
        {tab === "profile" ? <ProfileTab /> : null}
        {tab === "questions" ? <QuestionsTab /> : null}
        {tab === "workflow" ? <WorkflowTab /> : null}
        {tab === "knowledge" ? <KnowledgeTab /> : null}
        {tab === "hours" ? <HoursTab /> : null}
        {tab === "versions" ? <VersionsTab /> : null}
        {tab === "test" ? <TestTab /> : null}
      </fieldset>
    </>
  );
}
