"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { useCan, useMe } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Alert, Card, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { cn } from "@/lib/cn";
import { fmtBytes, fmtDate, fmtDateTime, plural } from "@/lib/format";
import type { KnowledgeCollection, KnowledgeDocument, Page } from "@/lib/types";
import { DocumentStatus, isProcessing } from "./document-status";
import { ACCEPT, useUploads } from "./uploads";

export function KnowledgePage() {
  const me = useMe();
  const router = useRouter();
  const params = useSearchParams();
  const canWrite = useCan("knowledge:write");
  const collections = useQuery({
    queryKey: ["collections"],
    queryFn: () => api<{ items: KnowledgeCollection[] }>("/knowledge/collections"),
  });
  const items = collections.data?.items ?? [];
  const selected = items.find((c) => c.id === params.get("collection")) ?? items[0];

  return (
    <>
      <PageHeader
        title="Knowledge Base"
        description="Documents your agents answer questions from. Group them into collections and pick collections per agent."
        actions={
          <Link
            href={`/t/${me.tenant.slug}/knowledge/search`}
            className="inline-flex h-10 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
          >
            Search playground
          </Link>
        }
      />
      {collections.error ? <Alert>{errorMessage(collections.error)}</Alert> : null}
      <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="space-y-4">
          <Card className="p-3">
            <h2 className="px-2 pt-1 pb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
              Collections
            </h2>
            <ul className="space-y-1">
              {items.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => router.replace(`?collection=${c.id}`)}
                    aria-current={c.id === selected?.id ? "true" : undefined}
                    className={cn(
                      "w-full rounded-lg px-3 py-2 text-left text-sm",
                      c.id === selected?.id
                        ? "bg-brand-50 font-medium text-brand-600 dark:bg-slate-800 dark:text-white"
                        : "hover:bg-slate-100 dark:hover:bg-slate-800",
                    )}
                  >
                    <span className="block truncate">{c.name}</span>
                    <span className="text-xs text-slate-500">{plural(c.documentCount, "document")}</span>
                  </button>
                </li>
              ))}
            </ul>
            {collections.data && !items.length ? (
              <p className="px-2 pb-2 text-sm text-slate-500">No collections yet.</p>
            ) : null}
          </Card>
          {canWrite ? <NewCollection onCreated={(id) => router.replace(`?collection=${id}`)} /> : null}
        </aside>
        <div className="min-w-0">
          {selected ? (
            <CollectionPanel key={selected.id} collection={selected} canWrite={canWrite} />
          ) : collections.data ? (
            <Card>
              <h2 className="font-semibold">Start your knowledge base</h2>
              <p className="mt-1 text-sm text-slate-500">
                Create a collection such as “Price list” or “Clinic FAQ”, then upload PDFs, Word or Excel
                files, CSVs, text or images.
              </p>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

function NewCollection({ onCreated }: { onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api<KnowledgeCollection>("/knowledge/collections", { method: "POST", body: { name } }),
    onSuccess: async (c) => {
      setName("");
      await qc.invalidateQueries({ queryKey: ["collections"] });
      onCreated(c.id);
    },
  });
  return (
    <Card className="p-4">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <TextField
          label="New collection"
          placeholder="e.g. Price list"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={create.error ? errorMessage(create.error) : undefined}
        />
        <Button
          type="submit"
          variant="secondary"
          className="w-full"
          loading={create.isPending}
          disabled={name.trim().length < 2}
        >
          Create collection
        </Button>
      </form>
    </Card>
  );
}

function CollectionPanel({ collection, canWrite }: { collection: KnowledgeCollection; canWrite: boolean }) {
  const me = useMe();
  const qc = useQueryClient();
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(collection.name);
  const [description, setDescription] = useState(collection.description ?? "");

  const docs = useInfiniteQuery({
    queryKey: ["documents", collection.id],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      api<Page<KnowledgeDocument>>(
        `/documents?${new URLSearchParams({ collectionId: collection.id, limit: "50", ...(pageParam ? { cursor: pageParam } : {}) })}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Poll while anything is still being processed
    refetchInterval: (q) =>
      q.state.data?.pages.some((p) => p.items.some((d) => isProcessing(d.status))) ? 2000 : false,
  });
  const rows = docs.data?.pages.flatMap((p) => p.items) ?? [];
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["documents", collection.id] });
    await qc.invalidateQueries({ queryKey: ["collections"] });
  };
  const { uploads, start, dismiss } = useUploads(collection.id, refresh);

  const save = useMutation({
    mutationFn: () =>
      api(`/knowledge/collections/${collection.id}`, {
        method: "PATCH",
        body: { name, ...(description.trim() ? { description } : {}) },
      }),
    onSuccess: async () => {
      setEditing(false);
      await qc.invalidateQueries({ queryKey: ["collections"] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/knowledge/collections/${collection.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["collections"] });
      router.replace("?");
    },
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/documents/${id}`, { method: "PATCH", body: { enabled } }),
    onSuccess: refresh,
  });
  const error = save.error ?? remove.error ?? toggle.error ?? docs.error;

  return (
    <div className="space-y-4">
      <Card>
        {editing ? (
          <form
            className="grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <TextField
              label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <div className="flex gap-2">
              <Button type="submit" loading={save.isPending} disabled={name.trim().length < 2}>
                Save
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">{collection.name}</h2>
              <p className="text-sm text-slate-500">{collection.description ?? "No description"}</p>
            </div>
            {canWrite ? (
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  className="text-red-600"
                  disabled={collection.documentCount > 0}
                  title={collection.documentCount > 0 ? "Delete its documents first" : undefined}
                  onClick={() => confirm(`Delete the collection “${collection.name}”?`) && remove.mutate()}
                >
                  Delete
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </Card>

      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      {rows.some((d) => d.status === "READY" && d.metadata.embedded === false) ? (
        <Alert tone="info">
          Some documents are searchable by keywords only because no embedding provider is configured. Add an
          AI provider key to match questions by meaning, then reprocess those documents.
        </Alert>
      ) : null}

      {canWrite ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            start([...e.dataTransfer.files]);
          }}
          className={cn(
            "rounded-2xl border-2 border-dashed p-6 text-center text-sm transition-colors",
            dragging
              ? "border-brand-500 bg-brand-50 dark:bg-slate-800"
              : "border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900",
          )}
        >
          <p className="font-medium">Drop files here to upload</p>
          <p className="mt-1 text-slate-500">
            PDF, Word (.docx), Excel (.xlsx), CSV, text, Markdown or images
          </p>
          <Button variant="secondary" className="mt-3" onClick={() => fileInput.current?.click()}>
            Choose files
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={ACCEPT}
            className="sr-only"
            aria-label="Choose files to upload"
            onChange={(e) => {
              start([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
        </div>
      ) : null}

      {uploads.length ? (
        <Card className="p-4">
          <ul className="space-y-2 text-sm">
            {uploads.map((u) => (
              <li key={u.key} className="flex flex-wrap items-center gap-3">
                <span className="min-w-0 flex-1 truncate">{u.name}</span>
                {u.error ? (
                  <>
                    <span className="text-red-600">{u.error}</span>
                    <Button variant="ghost" className="h-8 px-2" onClick={() => dismiss(u.key)}>
                      Dismiss
                    </Button>
                  </>
                ) : (
                  <DocumentStatus status="UPLOADING" progress={Math.round(u.progress * 100)} />
                )}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="border-b border-slate-200 text-left text-xs tracking-wide text-slate-500 uppercase dark:border-slate-800">
            <tr>
              <th className="px-4 py-3 font-medium">Document</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Size</th>
              <th className="px-4 py-3 text-right font-medium">Chunks</th>
              <th className="px-4 py-3 font-medium">Used</th>
              <th className="px-4 py-3 font-medium">Uploaded</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((d) => (
              <tr key={d.id}>
                <td className="max-w-72 px-4 py-3">
                  <Link
                    href={`/t/${me.tenant.slug}/knowledge/documents/${d.id}`}
                    className="block truncate font-medium hover:underline"
                  >
                    {d.title}
                  </Link>
                  <span className="block truncate text-xs text-slate-500">
                    {d.fileName}
                    {d.version > 1 ? ` · v${d.version}` : ""}
                    {d.agents.length ? ` · only ${d.agents.map((a) => a.name).join(", ")}` : ""}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <DocumentStatus status={d.status} progress={d.progress} message={d.statusMessage} compact />
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums">
                  {fmtBytes(d.sizeBytes)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {d.status === "READY" ? d.chunkCount : "—"}
                </td>
                <td className="px-4 py-3">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={d.enabled}
                      disabled={!canWrite}
                      onChange={(e) => toggle.mutate({ id: d.id, enabled: e.target.checked })}
                    />
                    <span className="sr-only">Use {d.title} in answers</span>
                    <span className="text-slate-500">{d.enabled ? "On" : "Off"}</span>
                  </label>
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-slate-500" title={fmtDateTime(d.createdAt)}>
                  {fmtDate(d.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {docs.data && !rows.length ? (
          <p className="px-4 py-6 text-sm text-slate-500">No documents in this collection yet.</p>
        ) : null}
        {docs.hasNextPage ? (
          <div className="border-t border-slate-100 p-3 text-center dark:border-slate-800">
            <Button
              variant="ghost"
              loading={docs.isFetchingNextPage}
              onClick={() => void docs.fetchNextPage()}
            >
              Load more
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
