"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useCan, useMe } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Check } from "@/components/ui/inputs";
import { Alert, Card, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { fmtSource } from "@/lib/format";
import type { AgentListItem, KnowledgeCollection, SearchHit } from "@/lib/types";

type Result = { hits: SearchHit[]; mode: "hybrid" | "keyword" };

/** Try questions callers might ask and see which passages an agent would answer from */
export function SearchPlayground() {
  const me = useMe();
  const [query, setQuery] = useState("");
  const [collectionIds, setCollectionIds] = useState<string[]>([]);
  const [agentId, setAgentId] = useState("");
  const [topK, setTopK] = useState(5);
  const collections = useQuery({
    queryKey: ["collections"],
    queryFn: () => api<{ items: KnowledgeCollection[] }>("/knowledge/collections"),
  });
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ items: AgentListItem[] }>("/agents"),
    enabled: useCan("agents:read"),
  });
  const search = useMutation({
    mutationFn: () =>
      api<Result>("/knowledge/search", {
        method: "POST",
        body: {
          query,
          topK,
          ...(collectionIds.length ? { collectionIds } : {}),
          ...(agentId ? { agentId } : {}),
        },
      }),
  });
  const best = search.data?.hits[0]?.score ?? 1;

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={`/t/${me.tenant.slug}/knowledge`} className="text-slate-500 hover:underline">
          ← Knowledge Base
        </Link>
      </p>
      <PageHeader
        title="Search playground"
        description="Ask a question the way a caller would and see the passages your agents would answer from."
      />
      <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <Card className="h-fit">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              search.mutate();
            }}
          >
            <TextField
              label="Question"
              placeholder="Is there parking near the clinic?"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-slate-700 dark:text-slate-300">
                Collections
              </legend>
              <div className="space-y-1.5">
                {collections.data?.items.map((c) => (
                  <Check
                    key={c.id}
                    label={c.name}
                    checked={collectionIds.includes(c.id)}
                    onChange={(v) =>
                      setCollectionIds((ids) => (v ? [...ids, c.id] : ids.filter((x) => x !== c.id)))
                    }
                  />
                ))}
              </div>
              <p className="mt-1 text-xs text-slate-500">None ticked searches every collection.</p>
            </fieldset>
            <SelectField
              label="As agent"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              hint="Applies documents restricted to specific agents"
            >
              <option value="">Any agent</option>
              {agents.data?.items.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="Results"
              value={String(topK)}
              onChange={(e) => setTopK(Number(e.target.value))}
            >
              {[3, 5, 10, 20].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </SelectField>
            <Button
              type="submit"
              className="w-full"
              loading={search.isPending}
              disabled={query.trim().length < 2}
            >
              Search
            </Button>
          </form>
        </Card>

        <div className="min-w-0 space-y-3">
          {search.error ? <Alert>{errorMessage(search.error)}</Alert> : null}
          {search.data ? (
            <>
              <p className="text-sm text-slate-500">
                {search.data.hits.length
                  ? `${search.data.hits.length} passage${search.data.hits.length === 1 ? "" : "s"}`
                  : "Nothing relevant found. The agent would say it doesn't know and offer a callback."}
                {search.data.mode === "keyword" ? " · keyword search only (no embeddings available)" : ""}
              </p>
              <ol className="space-y-3">
                {search.data.hits.map((h, i) => (
                  <li key={h.chunkId}>
                    <Card className="p-4">
                      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                        <Link
                          href={`/t/${me.tenant.slug}/knowledge/documents/${h.documentId}`}
                          className="font-medium hover:underline"
                        >
                          {i + 1}. {h.documentTitle}
                        </Link>
                        <span className="text-xs text-slate-500 tabular-nums">
                          {h.vectorScore !== null
                            ? `meaning ${h.vectorScore.toFixed(2)}`
                            : "no meaning match"}
                          {" · "}
                          {h.textScore !== null ? "keyword match" : "no keyword match"}
                        </span>
                      </div>
                      <div
                        className="mt-2 h-1 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
                        aria-hidden
                      >
                        <div
                          className="h-full rounded-full bg-brand-500"
                          style={{ width: `${Math.round((h.score / best) * 100)}%` }}
                        />
                      </div>
                      {fmtSource(h.metadata) ? (
                        <p className="mt-2 text-xs text-slate-500">{fmtSource(h.metadata)}</p>
                      ) : null}
                      <p className="mt-2 text-sm break-words whitespace-pre-wrap">{h.content}</p>
                    </Card>
                  </li>
                ))}
              </ol>
            </>
          ) : !search.error ? (
            <Card>
              <p className="text-sm text-slate-500">Results appear here.</p>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
