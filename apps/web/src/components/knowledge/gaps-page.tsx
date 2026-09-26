"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useCan, useMe } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/field";
import { TextArea } from "@/components/ui/inputs";
import { Alert, Card, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { fmtDateTime, plural } from "@/lib/format";
import type { KnowledgeCollection } from "@/lib/types";
import { reasonText } from "../calls/knowledge-events";

type Gap = {
  key: string;
  question: string;
  count: number;
  lastAskedAt: string;
  reasons: string[];
  examples: { question: string; callId: string; at: string }[];
};

/** Questions callers asked that the agents couldn't answer from knowledge, most frequent first */
export function KnowledgeGapsPage() {
  const me = useMe();
  const qc = useQueryClient();
  const canWrite = useCan("knowledge:write");
  const [days, setDays] = useState(30);
  const [answering, setAnswering] = useState<Gap | null>(null);
  const [answer, setAnswer] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [added, setAdded] = useState<string | null>(null);

  const gaps = useQuery({
    queryKey: ["knowledge-gaps", days],
    queryFn: () => api<{ items: Gap[]; questions: number }>(`/knowledge/gaps?days=${days}`),
  });
  const collections = useQuery({
    queryKey: ["collections"],
    queryFn: () => api<{ items: KnowledgeCollection[] }>("/knowledge/collections"),
  });
  const save = useMutation({
    mutationFn: (g: Gap) =>
      api("/knowledge/faq", {
        method: "POST",
        body: {
          collectionId: collectionId || collections.data?.items[0]?.id,
          question: g.question,
          answer,
          gapKey: g.key,
        },
      }),
    onSuccess: async (_d, g) => {
      setAdded(g.question);
      setAnswering(null);
      setAnswer("");
      await qc.invalidateQueries({ queryKey: ["knowledge-gaps"] });
      await qc.invalidateQueries({ queryKey: ["documents"] });
      await qc.invalidateQueries({ queryKey: ["collections"] });
    },
  });
  const fieldError = (p: string) =>
    save.error instanceof ApiError ? save.error.fieldErrors.find((e) => e.path === p)?.message : undefined;

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={`/t/${me.tenant.slug}/knowledge`} className="text-slate-500 hover:underline">
          ← Knowledge Base
        </Link>
      </p>
      <PageHeader
        title="Knowledge gaps"
        description="Questions callers asked that your agents couldn't answer from your documents. Add an answer and agents use it on the next call."
        actions={
          <SelectField
            label="Period"
            value={String(days)}
            onChange={(e) => setDays(Number(e.target.value))}
            className="w-40"
          >
            {[7, 30, 90].map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </SelectField>
        }
      />
      <div className="space-y-4">
        {gaps.error ? <Alert>{errorMessage(gaps.error)}</Alert> : null}
        {added ? (
          <Alert tone="success">
            Added an answer to “{added}”. It is searchable as soon as it finishes processing.
          </Alert>
        ) : null}
        {gaps.data && !gaps.data.items.length ? (
          <Card>
            <p className="text-sm text-slate-500">
              No unanswered questions in this period. Your knowledge base is covering what callers ask.
            </p>
          </Card>
        ) : null}
        <ul className="space-y-3">
          {gaps.data?.items.map((g) => (
            <li key={g.key}>
              <Card className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">“{g.question}”</p>
                    <p className="mt-0.5 text-sm text-slate-500">
                      Asked {plural(g.count, "time")} · last {fmtDateTime(g.lastAskedAt)}
                      {g.reasons.length ? ` · ${g.reasons.map(reasonText).join("; ")}` : ""}
                    </p>
                  </div>
                  {canWrite ? (
                    <Button
                      variant="secondary"
                      onClick={() => setAnswering(g)}
                      disabled={!collections.data?.items.length}
                    >
                      Add answer
                    </Button>
                  ) : null}
                </div>
                {g.examples.length > 1 ? (
                  <details className="mt-2 text-sm">
                    <summary className="cursor-pointer text-slate-500">How callers asked it</summary>
                    <ul className="mt-1 space-y-1">
                      {g.examples.map((x) => (
                        <li key={`${x.callId}-${x.at}`}>
                          “{x.question}” ·{" "}
                          <Link
                            href={`/t/${me.tenant.slug}/calls/${x.callId}`}
                            className="text-brand-600 hover:underline"
                          >
                            call
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
        {canWrite && collections.data && !collections.data.items.length ? (
          <Alert tone="info">Create a knowledge collection first; answers are saved into one.</Alert>
        ) : null}
      </div>

      <Dialog open={Boolean(answering)} onClose={() => setAnswering(null)} title="Add an answer">
        {answering ? (
          <form
            className="space-y-4 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(answering);
            }}
          >
            <p>
              Callers asked: <span className="font-medium">“{answering.question}”</span>
            </p>
            {save.error && !fieldError("answer") ? <Alert>{errorMessage(save.error)}</Alert> : null}
            <TextArea
              label="Answer"
              rows={4}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              error={fieldError("answer")}
              hint="Write it as you'd say it on the phone. Agents only repeat facts that are written here."
            />
            <SelectField
              label="Save to collection"
              value={collectionId || collections.data?.items[0]?.id || ""}
              onChange={(e) => setCollectionId(e.target.value)}
            >
              {collections.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SelectField>
            <div className="flex justify-end">
              <Button type="submit" loading={save.isPending} disabled={answer.trim().length < 2}>
                Add to knowledge
              </Button>
            </div>
          </form>
        ) : null}
      </Dialog>
    </>
  );
}
