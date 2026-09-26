import Link from "next/link";
import type { CallEvent } from "@/lib/types";

type Source = { chunkId: string; documentId: string; title: string; page?: number; headingPath?: string[] };
export type RagPayload = {
  question?: string;
  answered?: "grounded" | "safe" | boolean;
  method?: "generated" | "extractive" | null;
  reason?: string | null;
  used?: Source[];
};

const REASON: Record<string, string> = {
  no_collections: "the agent has no knowledge collections",
  no_hits: "no matching documents",
  not_relevant: "nothing relevant in the knowledge base",
  not_in_sources: "the documents don't answer it",
  weak_match: "no close enough match",
  ungrounded: "the AI answer couldn't be verified against the documents",
  rejected: "the answer was blocked by a safety check",
  llm_error: "the AI was unavailable",
  error: "the knowledge search failed",
};

export const reasonText = (r: string | null | undefined) => (r ? (REASON[r] ?? r.replace(/_/g, " ")) : "");

export const isAnswered = (p: RagPayload) => p.answered === "grounded" || p.answered === true;

export function sourceLabel(s: Source): string {
  return [s.title, ...(s.headingPath ?? [])].join(" › ") + (s.page !== undefined ? ` · page ${s.page}` : "");
}

export function SourceLinks({ sources, slug }: { sources: Source[]; slug: string }) {
  return (
    <ul className="mt-1 space-y-0.5">
      {sources.map((s) => (
        <li key={s.chunkId}>
          <Link
            href={`/t/${slug}/knowledge/documents/${s.documentId}`}
            className="text-brand-600 hover:underline"
          >
            {sourceLabel(s)}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** A caller's question on the timeline: answered from which documents, or why it needs a follow-up */
export function KnowledgeEvent({ event, slug }: { event: CallEvent; slug: string }) {
  const p = event.payload as RagPayload;
  const answered = isAnswered(p);
  return (
    <li className="rounded-xl border border-slate-200 px-3 py-2 text-xs dark:border-slate-800">
      <p className="font-medium text-slate-700 dark:text-slate-200">Question: “{p.question ?? "…"}”</p>
      {answered ? (
        <>
          <p className="mt-0.5 text-green-700 dark:text-green-400">
            Answered from knowledge
            {p.method === "extractive"
              ? " (quoted)"
              : p.method === "generated"
                ? " (written by AI, verified)"
                : ""}
          </p>
          {p.used?.length ? <SourceLinks sources={p.used} slug={slug} /> : null}
        </>
      ) : (
        <p className="mt-0.5 text-amber-700 dark:text-amber-300">
          Follow-up needed{p.reason ? `: ${reasonText(p.reason)}` : ""}
        </p>
      )}
    </li>
  );
}
