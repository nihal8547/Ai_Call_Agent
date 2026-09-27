"use client";

import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/field";
import { Check, Section } from "@/components/ui/inputs";
import { Alert, Badge } from "@/components/ui/misc";
import { StatusPill } from "@/components/ui/status-pill";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { cn } from "@/lib/cn";
import { useMe } from "@/components/app/me-context";
import { fmtValue, humanize, numberLocale } from "@/lib/format";
import { useDraft } from "./draft-context";

type TestReply = {
  sessionId: string;
  version: number;
  reply: string;
  control: "listen" | "hangup" | "transfer" | "await_tool";
  transferTo: string | null;
  state: {
    stepId: string | null;
    collected: Record<string, unknown>;
    skipped: string[];
    awaiting: { kind: string; prompt: string; fieldKey?: string } | null;
    pendingQuestions: string[];
    fallbackOnly: boolean;
    ended: boolean;
    outcome: string | null;
    qualification: string;
  };
  toolCalls: { tool: string; background: boolean }[];
  events: { type: string; [k: string]: unknown }[];
  metrics: { totalMs: number; deterministic: boolean };
};

type Line = { who: "agent" | "you" | "system"; text: string };

export function TestTab() {
  const me = useMe();
  const { agent, dirty } = useDraft();
  const [target, setTarget] = useState<"draft" | "published">(agent.draft ? "draft" : "published");
  const [at, setAt] = useState("");
  const [failTools, setFailTools] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [last, setLast] = useState<TestReply | null>(null);
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [lines]);

  const record = (r: TestReply) => {
    const system: Line[] = [
      ...r.toolCalls.map((t) => ({
        who: "system" as const,
        text: `⚙ ${t.tool}${t.background ? " (background)" : ""} — simulated`,
      })),
      ...(r.control === "transfer"
        ? [{ who: "system" as const, text: `☎ Transferred to ${r.transferTo}` }]
        : []),
      ...(r.state.ended
        ? [{ who: "system" as const, text: `Call ended: ${humanize(r.state.outcome ?? "NONE")}` }]
        : []),
    ];
    setLines((l) => [...l, { who: "agent", text: r.reply || "(silence)" }, ...system]);
    setLast(r);
  };

  const start = useMutation({
    mutationFn: () => {
      const versionId = target === "draft" ? agent.draft?.id : agent.published?.id;
      return api<TestReply>(`/agents/${agent.id}/test-sessions`, {
        method: "POST",
        body: {
          ...(versionId ? { versionId } : {}),
          ...(at ? { simulatedAt: new Date(at).toISOString() } : {}),
          failTools,
        },
      });
    },
    onSuccess: (r) => {
      setLines([]);
      record(r);
    },
  });
  const send = useMutation({
    mutationFn: (message: string) =>
      api<TestReply>(`/test-sessions/${last!.sessionId}/messages`, {
        method: "POST",
        body: { text: message },
      }),
    onSuccess: record,
  });
  const error = start.error ?? send.error;
  const live = last && !last.state.ended && last.control !== "transfer";

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <Section
        title="Test call"
        description="Talk to the agent by typing. Uses the real call engine; tools are simulated and nothing is saved."
        actions={
          <Button
            loading={start.isPending}
            disabled={dirty}
            title={dirty ? "Save your changes to test them" : undefined}
            onClick={() => start.mutate()}
          >
            {last ? "Restart" : "Start test call"}
          </Button>
        }
      >
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <SelectField
            label="Version"
            value={target}
            onChange={(e) => setTarget(e.target.value as "draft" | "published")}
          >
            {agent.draft ? <option value="draft">Draft v{agent.draft.version}</option> : null}
            {agent.published ? <option value="published">Live v{agent.published.version}</option> : null}
          </SelectField>
          <label className="text-sm font-medium">
            Pretend the time is
            <input
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
              className="mt-1.5 block h-10 w-full rounded-lg border border-slate-300 bg-white px-2 dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
          <div className="sm:mt-7">
            <Check label="Make tools fail" checked={failTools} onChange={setFailTools} />
          </div>
        </div>
        {dirty ? <Alert tone="info">You have unsaved changes. Save the draft to test them.</Alert> : null}
        {error ? <Alert>{errorMessage(error)}</Alert> : null}

        <div
          className="mt-2 h-96 space-y-2 overflow-y-auto rounded-xl bg-slate-50 p-3 dark:bg-slate-950"
          aria-live="polite"
        >
          {!lines.length ? (
            <p className="text-sm text-slate-500">Press “Start test call” to hear the greeting.</p>
          ) : null}
          {lines.map((l, i) =>
            l.who === "system" ? (
              <p key={i} className="text-center text-xs text-slate-500">
                {l.text}
              </p>
            ) : (
              <div key={i} className={cn("flex", l.who === "you" ? "justify-end" : "justify-start")}>
                <p
                  dir="auto"
                  className={cn(
                    "max-w-[85%] rounded-2xl px-3 py-2 text-sm",
                    l.who === "you"
                      ? "bg-brand-600 text-white"
                      : "bg-white text-slate-900 shadow-xs dark:bg-slate-800 dark:text-slate-100",
                  )}
                >
                  {l.text}
                </p>
              </div>
            ),
          )}
          <div ref={end} />
        </div>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!live) return;
            setLines((l) => [...l, { who: "you", text: text || "(silence)" }]);
            send.mutate(text);
            setText("");
          }}
        >
          <input
            aria-label="Your reply"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={!live}
            placeholder={live ? "Type what the caller says (empty = silence)" : "Start a test call first"}
            className="h-10 flex-1 rounded-lg border border-slate-300 bg-white px-3 text-sm disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900"
          />
          <Button type="submit" loading={send.isPending} disabled={!live}>
            Send
          </Button>
        </form>
      </Section>

      <div className="space-y-6">
        <Section title="Call state">
          {last ? (
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-slate-500">Step</dt>
                <dd>
                  <code>{last.state.stepId ?? "—"}</code>
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Waiting for</dt>
                <dd>{last.state.awaiting ? (last.state.awaiting.fieldKey ?? "confirmation") : "—"}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Collected</dt>
                <dd>
                  {Object.entries(last.state.collected).map(([k, v]) => (
                    <p key={k}>
                      <span className="text-slate-500">{humanize(k)}:</span>{" "}
                      {fmtValue(v, numberLocale(me.tenant.currency))}
                    </p>
                  ))}
                  {!Object.keys(last.state.collected).length ? "Nothing yet" : null}
                </dd>
              </div>
              {last.state.skipped.length ? (
                <div>
                  <dt className="text-slate-500">Skipped</dt>
                  <dd>{last.state.skipped.join(", ")}</dd>
                </div>
              ) : null}
              {last.state.pendingQuestions.length ? (
                <div>
                  <dt className="text-slate-500">Questions for the team</dt>
                  <dd>{last.state.pendingQuestions.join(" · ")}</dd>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <StatusPill value={last.state.qualification} />
                {last.state.outcome ? <StatusPill value={last.state.outcome} /> : null}
                <Badge>
                  {last.metrics.deterministic ? "rule-based" : "AI"} · {last.metrics.totalMs} ms
                </Badge>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-slate-500">Starts with the first test call.</p>
          )}
        </Section>
        <Section title="Last turn events">
          <ul className="space-y-1 overflow-hidden text-xs">
            {last?.events.map((e, i) => (
              <li key={i}>
                <code>{e.type}</code>{" "}
                <span className="text-slate-500">
                  {JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => k !== "type"))).slice(
                    0,
                    120,
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}
