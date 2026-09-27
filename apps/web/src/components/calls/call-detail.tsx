"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useCan, useMe } from "@/components/app/me-context";
import { Alert, Card, PageHeader } from "@/components/ui/misc";
import { StatusPill } from "@/components/ui/status-pill";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { cn } from "@/lib/cn";
import { isAnswered, KnowledgeEvent, type RagPayload, SourceLinks } from "./knowledge-events";
import { fmtDateTime, fmtDuration, fmtValue, humanize, numberLocale } from "@/lib/format";
import type { CallDetail, CallEvent } from "@/lib/types";

export function CallDetailPage({ id }: { id: string }) {
  const me = useMe();
  const canTranscript = useCan("calls:read_transcript");
  const call = useQuery({ queryKey: ["call", id], queryFn: () => api<CallDetail>(`/calls/${id}`) });
  const events = useQuery({
    queryKey: ["call-events", id],
    queryFn: () => api<{ items: CallEvent[] }>(`/calls/${id}/events`),
    enabled: canTranscript,
  });
  const knowledge = (() => {
    const rag = (events.data?.items ?? [])
      .filter((e) => e.type === "RAG_RETRIEVAL")
      .map((e) => e.payload as RagPayload);
    const seen = new Map<string, NonNullable<RagPayload["used"]>[number]>();
    for (const p of rag) for (const src of p.used ?? []) seen.set(src.chunkId, src);
    return {
      asked: rag,
      sources: [...seen.values()],
      unanswered: rag.filter((p) => !isAnswered(p) && p.question).map((p) => p.question!),
    };
  })();

  if (call.error) return <Alert>{errorMessage(call.error)}</Alert>;
  const c = call.data;
  if (!c) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <>
      <PageHeader
        title={`Call from ${c.fromNumber}`}
        description={`${fmtDateTime(c.startedAt)} · ${c.agent.name} (v${c.agentVersion.version})`}
        actions={
          <div className="flex gap-2">
            <StatusPill value={c.status} />
            <StatusPill value={c.outcome} />
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Card>
          <h2 className="font-semibold">Conversation</h2>
          {!canTranscript ? (
            <p className="mt-2 text-sm text-slate-500">You don't have permission to view transcripts.</p>
          ) : null}
          {events.error ? <Alert>{errorMessage(events.error)}</Alert> : null}
          <ol className="mt-4 space-y-3">
            {events.data?.items.map((e) =>
              e.type === "RAG_RETRIEVAL" ? (
                <KnowledgeEvent key={e.id} event={e} slug={me.tenant.slug} />
              ) : (
                <TimelineItem key={e.id} event={e} />
              ),
            )}
          </ol>
        </Card>
        <div className="space-y-6">
          <Card>
            <h2 className="font-semibold">Details</h2>
            <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-slate-500">Duration</dt>
              <dd>{fmtDuration(c.durationSec)}</dd>
              <dt className="text-slate-500">Turns</dt>
              <dd>{c.totalTurns}</dd>
              <dt className="text-slate-500">Without LLM</dt>
              <dd>{c.fallbackTurns}</dd>
              <dt className="text-slate-500">Qualification</dt>
              <dd>
                <StatusPill value={c.qualificationStatus} />
              </dd>
            </dl>
          </Card>
          <Card>
            <h2 className="font-semibold">Collected</h2>
            {Object.keys(c.collectedData).length ? (
              <dl className="mt-3 space-y-2 text-sm">
                {Object.entries(c.collectedData).map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-slate-500">{humanize(k)}</dt>
                    <dd className="font-medium" dir="auto">
                      {fmtValue(v, numberLocale(me.tenant.currency))}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="mt-2 text-sm text-slate-500">Nothing collected.</p>
            )}
          </Card>
          {knowledge.asked.length ? (
            <Card>
              <h2 className="font-semibold">Knowledge used</h2>
              {knowledge.sources.length ? (
                <div className="mt-2 text-sm">
                  <SourceLinks sources={knowledge.sources} slug={me.tenant.slug} />
                </div>
              ) : (
                <p className="mt-2 text-sm text-slate-500">No documents were used.</p>
              )}
              {knowledge.unanswered.length ? (
                <>
                  <h3 className="mt-4 text-sm font-medium">Couldn't answer</h3>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                    {knowledge.unanswered.map((q, i) => (
                      <li key={i}>{q}</li>
                    ))}
                  </ul>
                  <Link
                    href={`/t/${me.tenant.slug}/knowledge/gaps`}
                    className="mt-2 inline-block text-sm text-brand-600 hover:underline"
                  >
                    Add answers in Knowledge gaps
                  </Link>
                </>
              ) : null}
            </Card>
          ) : null}
          <Card>
            <h2 className="font-semibold">Result</h2>
            {c.summary ? (
              <p className="mt-2 text-sm" dir="auto">
                {c.summary}
              </p>
            ) : null}
            <ul className="mt-3 space-y-1 text-sm">
              {c.leads.map((l) => (
                <li key={l.id}>
                  Lead:{" "}
                  <Link
                    className="text-brand-600 hover:underline"
                    href={`/t/${me.tenant.slug}/leads?focus=${l.id}`}
                  >
                    {l.customerName ?? "Unnamed"}
                  </Link>{" "}
                  · {l.status.label}
                </li>
              ))}
              {c.appointments.map((a) => (
                <li key={a.id}>
                  Appointment: {a.title} · {fmtDateTime(a.startsAt, me.tenant.timezone)}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}

function TimelineItem({ event: e }: { event: CallEvent }) {
  const locale = numberLocale(useMe().tenant.currency);
  const p = e.payload as Record<string, unknown>;
  if (e.type === "USER_TURN" || e.type === "AGENT_TURN") {
    const caller = e.type === "USER_TURN";
    const text = String(p.text ?? "") || "(silence)";
    return (
      <li className={cn("flex", caller ? "justify-end" : "justify-start")}>
        <div
          className={cn(
            "max-w-[85%] rounded-2xl px-4 py-2 text-sm",
            caller
              ? "bg-brand-600 text-white"
              : "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100",
          )}
        >
          <p className="mb-0.5 text-[11px] font-medium opacity-70">
            {caller ? "Caller" : "Agent"}
            {!caller && p.deterministic === false ? " · AI phrased" : ""}
            {!caller && e.latencyMs !== null ? ` · ${e.latencyMs} ms` : ""}
          </p>
          <p dir="auto">{text}</p>
        </div>
      </li>
    );
  }
  const describe: Record<string, () => string> = {
    CALL_STARTED: () => "Call started",
    EXTRACTION: () =>
      `Captured ${humanize(String(p.field))}: ${fmtValue(p.value, locale)}${p.correction ? " (corrected)" : ""}`,
    VALIDATION_ERROR: () => `Rejected ${humanize(String(p.field))}: ${String(p.error)}`,
    RAG_RETRIEVAL: () =>
      p.question
        ? `Question: "${String(p.question)}" → ${p.answered === "grounded" ? "answered from knowledge" : "follow-up needed"}`
        : `Knowledge lookup: ${p.answered ? "found" : "nothing relevant"}`,
    TOOL_CALL: () =>
      `${String(p.tool)} ${p.phase === "requested" ? "requested" : p.ok ? "succeeded" : `failed (${String(p.error)})`}`,
    FALLBACK: () => `Fallback: ${humanize(String(p.reason))}`,
    GUARD_BLOCKED: () => "Unsafe reply blocked",
    HANDOFF: () => (p.transferred ? "Transferred to a person" : "Person unavailable, message taken"),
    CALL_ENDED: () => `Call ended: ${humanize(String(p.outcome))}`,
  };
  return (
    <li className="flex items-center gap-2 text-xs text-slate-500">
      <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" aria-hidden />
      <span>{describe[e.type]?.() ?? humanize(e.type)}</span>
      <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" aria-hidden />
    </li>
  );
}
