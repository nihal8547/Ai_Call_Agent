"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useCan, useMe } from "@/components/app/me-context";
import { SelectField } from "@/components/ui/field";
import { Check, Section } from "@/components/ui/inputs";
import { Alert } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { plural } from "@/lib/format";
import type { KnowledgeCollection } from "@/lib/types";
import { useDraft } from "./draft-context";

export function KnowledgeTab() {
  const me = useMe();
  const { config, update, errorFor } = useDraft();
  const canRead = useCan("knowledge:read");
  const collections = useQuery({
    queryKey: ["collections"],
    queryFn: () => api<{ items: KnowledgeCollection[] }>("/knowledge/collections"),
    enabled: canRead,
  });
  const k = config.knowledge;
  const known = new Set(collections.data?.items.map((c) => c.id));
  const missing = collections.data ? k.collectionIds.filter((id) => !known.has(id)) : [];
  const listError = k.collectionIds.map((_, i) => errorFor(`knowledge.collectionIds.${i}`)).find(Boolean);

  return (
    <div className="space-y-6">
      <Section
        title="Knowledge collections"
        description="The agent answers callers' questions only from these documents. With none selected it offers a callback instead of guessing."
      >
        {!canRead ? (
          <p className="text-sm text-slate-500">You don't have access to the knowledge base.</p>
        ) : collections.data && !collections.data.items.length ? (
          <p className="text-sm text-slate-500">
            No collections yet.{" "}
            <Link href={`/t/${me.tenant.slug}/knowledge`} className="underline">
              Create one in the Knowledge Base
            </Link>
            .
          </p>
        ) : (
          <div className="space-y-2">
            {collections.data?.items.map((c) => (
              <Check
                key={c.id}
                label={c.name}
                hint={plural(c.documentCount, "document")}
                checked={k.collectionIds.includes(c.id)}
                onChange={(v) =>
                  update((cfg) => {
                    cfg.knowledge.collectionIds = v
                      ? [...cfg.knowledge.collectionIds, c.id]
                      : cfg.knowledge.collectionIds.filter((x) => x !== c.id);
                  })
                }
              />
            ))}
          </div>
        )}
        {missing.length || listError ? (
          <div className="mt-4">
            <Alert>
              {listError ?? "Some selected collections no longer exist."}{" "}
              <button
                type="button"
                className="underline"
                onClick={() =>
                  update((cfg) => {
                    cfg.knowledge.collectionIds = cfg.knowledge.collectionIds.filter((id) => known.has(id));
                  })
                }
              >
                Remove them
              </button>
            </Alert>
          </div>
        ) : null}
      </Section>

      <Section
        title="Answer quality"
        description="How much the agent reads before answering, and how close a match must be."
      >
        <div className="grid max-w-xl gap-4 sm:grid-cols-2">
          <SelectField
            label="Passages per answer"
            value={String(k.topK)}
            error={errorFor("knowledge.topK")}
            onChange={(e) => update((cfg) => void (cfg.knowledge.topK = Number(e.target.value)))}
            hint="More passages give more context but slower replies"
          >
            {[2, 3, 4, 5, 6, 8, 10].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Match strictness"
            value={String(k.minScore)}
            error={errorFor("knowledge.minScore")}
            onChange={(e) => update((cfg) => void (cfg.knowledge.minScore = Number(e.target.value)))}
            hint="Stricter means fewer, more relevant answers"
          >
            {[
              [0.4, "Relaxed (0.40)"],
              [0.5, "Balanced (0.50)"],
              [0.55, "Default (0.55)"],
              [0.65, "Strict (0.65)"],
              [0.75, "Very strict (0.75)"],
            ].map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
            {![0.4, 0.5, 0.55, 0.65, 0.75].includes(k.minScore) ? (
              <option value={k.minScore}>Custom ({k.minScore.toFixed(2)})</option>
            ) : null}
          </SelectField>
        </div>
        <p className="mt-4 text-sm text-slate-500">
          Try questions in the{" "}
          <Link href={`/t/${me.tenant.slug}/knowledge/search`} className="underline">
            search playground
          </Link>{" "}
          to see what the agent would find.
        </p>
      </Section>
    </div>
  );
}
