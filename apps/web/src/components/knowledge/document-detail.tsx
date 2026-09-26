"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useCan, useMe } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Check, Section } from "@/components/ui/inputs";
import { Alert, Card, PageHeader } from "@/components/ui/misc";
import { api, upload } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { fmtBytes, fmtDateTime, fmtSource } from "@/lib/format";
import type { AgentListItem, DocumentDetail as Detail, KnowledgeDocument } from "@/lib/types";
import { DocumentStatus, isProcessing } from "./document-status";
import { ACCEPT } from "./uploads";

export function DocumentDetail({ id }: { id: string }) {
  const me = useMe();
  const qc = useQueryClient();
  const router = useRouter();
  const canWrite = useCan("knowledge:write");
  const canReadAgents = useCan("agents:read");
  const replaceInput = useRef<HTMLInputElement>(null);
  const [replaceProgress, setReplaceProgress] = useState<number | null>(null);

  const doc = useQuery({
    queryKey: ["document", id],
    queryFn: () => api<Detail>(`/documents/${id}`),
    refetchInterval: (q) => (q.state.data && isProcessing(q.state.data.status) ? 2000 : false),
    retry: false,
  });
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ items: AgentListItem[] }>("/agents"),
    enabled: canReadAgents,
  });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["document", id] });
    await qc.invalidateQueries({ queryKey: ["documents"] });
  };

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/documents/${id}`, { method: "PATCH", body }),
    onSuccess: refresh,
  });
  const reprocess = useMutation({
    mutationFn: () => api(`/documents/${id}/reprocess`, { method: "POST" }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api(`/documents/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["collections"] });
      router.push(`/t/${me.tenant.slug}/knowledge?collection=${doc.data?.collectionId ?? ""}`);
    },
  });
  const replace = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return upload<KnowledgeDocument>(`/documents/${id}/replace`, form, setReplaceProgress);
    },
    onSettled: () => setReplaceProgress(null),
    onSuccess: (next) => {
      router.push(`/t/${me.tenant.slug}/knowledge/documents/${next.id}`);
    },
  });
  const error = patch.error ?? reprocess.error ?? remove.error ?? replace.error;

  if (doc.error) return <Alert>{errorMessage(doc.error)}</Alert>;
  const d = doc.data;
  if (!d) return <p className="text-sm text-slate-500">Loading…</p>;
  const busy = isProcessing(d.status);
  const restrictedTo = new Set(d.agents.map((a) => a.id));

  return (
    <>
      <p className="mb-2 text-sm">
        <Link
          href={`/t/${me.tenant.slug}/knowledge?collection=${d.collectionId}`}
          className="text-slate-500 hover:underline"
        >
          ← Knowledge Base
        </Link>
      </p>
      <PageHeader
        title={d.title}
        description={`${d.fileName} · ${fmtBytes(d.sizeBytes)} · version ${d.version}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <a
              href={`/api/v1/documents/${d.id}/download`}
              className="inline-flex h-10 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
            >
              Download
            </a>
            {canWrite ? (
              <>
                <Button
                  variant="secondary"
                  disabled={busy}
                  loading={replaceProgress !== null}
                  onClick={() => replaceInput.current?.click()}
                >
                  {replaceProgress !== null
                    ? `Uploading ${Math.round(replaceProgress * 100)}%`
                    : "Replace file"}
                </Button>
                <input
                  ref={replaceInput}
                  type="file"
                  accept={ACCEPT}
                  className="sr-only"
                  aria-label="Choose a replacement file"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) replace.mutate(file);
                    e.target.value = "";
                  }}
                />
                <Button
                  variant="secondary"
                  disabled={busy}
                  loading={reprocess.isPending}
                  onClick={() => reprocess.mutate()}
                >
                  Reprocess
                </Button>
                <Button
                  variant="danger"
                  loading={remove.isPending}
                  onClick={() =>
                    confirm(`Delete “${d.title}”? Agents stop using it immediately.`) && remove.mutate()
                  }
                >
                  Delete
                </Button>
              </>
            ) : null}
          </div>
        }
      />
      <div className="space-y-4">
        {error ? <Alert>{errorMessage(error)}</Alert> : null}
        {d.replacesId ? (
          <Alert tone="info">
            This is a new version. The{" "}
            <Link href={`/t/${me.tenant.slug}/knowledge/documents/${d.replacesId}`} className="underline">
              previous version
            </Link>{" "}
            stays in use until this one is ready, then it is removed.
          </Alert>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <h2 className="font-semibold">Processing</h2>
            <div className="mt-3">
              <DocumentStatus status={d.status} progress={d.progress} message={d.statusMessage} />
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-slate-500">Type</dt>
              <dd className="uppercase">{d.metadata.kind ?? d.mimeType}</dd>
              <dt className="text-slate-500">Pages</dt>
              <dd className="tabular-nums">{d.pageCount ?? "—"}</dd>
              <dt className="text-slate-500">Chunks</dt>
              <dd className="tabular-nums">{d.status === "READY" ? d.chunkCount : "—"}</dd>
              <dt className="text-slate-500">Search</dt>
              <dd>
                {d.status !== "READY" ? "—" : d.metadata.embedded ? "Meaning + keywords" : "Keywords only"}
              </dd>
              {d.metadata.ocr ? (
                <>
                  <dt className="text-slate-500">Text</dt>
                  <dd>Read with OCR</dd>
                </>
              ) : null}
              <dt className="text-slate-500">Uploaded</dt>
              <dd>{fmtDateTime(d.createdAt)}</dd>
              <dt className="text-slate-500">Processed</dt>
              <dd>{fmtDateTime(d.processedAt)}</dd>
            </dl>
          </Card>

          <Card>
            <h2 className="font-semibold">Settings</h2>
            <form
              className="mt-3 flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const title = String(new FormData(e.currentTarget).get("title") ?? "").trim();
                if (title && title !== d.title) patch.mutate({ title });
              }}
            >
              <TextField
                key={d.title}
                name="title"
                label="Title"
                defaultValue={d.title}
                disabled={!canWrite}
                className="flex-1"
              />
              {canWrite ? (
                <Button type="submit" variant="secondary" loading={patch.isPending}>
                  Save
                </Button>
              ) : null}
            </form>
            <div className="mt-4">
              <Check
                label="Use this document in answers"
                hint="Turn off to hide it from every agent without deleting it."
                checked={d.enabled}
                onChange={(v) => canWrite && patch.mutate({ enabled: v })}
              />
            </div>
          </Card>
        </div>

        {canReadAgents ? (
          <Section
            title="Agents"
            description="By default every agent using this collection can answer from this document. Tick agents to restrict it to them."
          >
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {agents.data?.items.map((a) => (
                <Check
                  key={a.id}
                  label={a.name}
                  checked={restrictedTo.has(a.id)}
                  onChange={(v) => {
                    if (!canWrite) return;
                    const next = new Set(restrictedTo);
                    if (v) next.add(a.id);
                    else next.delete(a.id);
                    patch.mutate({ agentIds: [...next] });
                  }}
                />
              ))}
            </div>
            {agents.data && !agents.data.items.length ? (
              <p className="text-sm text-slate-500">No agents yet.</p>
            ) : null}
            <p className="mt-3 text-sm text-slate-500">
              {d.agents.length
                ? `Only ${d.agents.map((a) => a.name).join(", ")}`
                : "All agents using this collection"}
            </p>
          </Section>
        ) : null}

        <Section
          title="Preview"
          description="The first chunks your agents search, as extracted from the file."
        >
          {d.preview.length ? (
            <ol className="space-y-3">
              {d.preview.map((c) => (
                <li
                  key={c.ordinal}
                  className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800"
                >
                  <p className="mb-1 text-xs text-slate-500">
                    #{c.ordinal + 1}
                    {fmtSource(c.metadata) ? ` · ${fmtSource(c.metadata)}` : ""} · {c.tokenCount} tokens
                  </p>
                  <p className="break-words whitespace-pre-wrap">{c.content}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-slate-500">
              {busy ? "Available once processing finishes." : "No text."}
            </p>
          )}
        </Section>
      </div>
    </>
  );
}
