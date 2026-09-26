"use client";

import type { FieldError } from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useCan, useMe } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Alert, Card, PageHeader } from "@/components/ui/misc";
import { StatusPill } from "@/components/ui/status-pill";
import { api } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import type { AgentConfigJson, AgentDetail, FieldJson } from "@/lib/types";

const FIELD_TYPES = [
  "text",
  "name",
  "number",
  "currency",
  "select",
  "multiselect",
  "boolean",
  "date",
  "time",
  "phone",
  "email",
];
const textarea =
  "block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 focus:outline-2 focus:outline-brand-500";

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "f_$1")
    .slice(0, 40) || "field";

/**
 * Basic agent editor (level 1): identity, behaviour and qualification questions.
 * Edits go to a draft; calls keep using the published version until "Publish".
 * The full workflow editor and test console arrive in P7.
 */
export function AgentEditor({ id }: { id: string }) {
  const me = useMe();
  const qc = useQueryClient();
  const canWrite = useCan("agents:write");
  const canPublish = useCan("agents:publish");
  const agent = useQuery({ queryKey: ["agent", id], queryFn: () => api<AgentDetail>(`/agents/${id}`) });
  const source = agent.data?.draft ?? agent.data?.published;
  const [config, setConfig] = useState<AgentConfigJson | null>(null);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (source && !dirty) setConfig(structuredClone(source.config));
  }, [source, dirty]);

  const update = (fn: (c: AgentConfigJson) => void) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
    setDirty(true);
    setNotice(null);
  };

  const save = useMutation({
    mutationFn: () => api(`/agents/${id}/draft`, { method: "PUT", body: { config } }),
    onSuccess: async () => {
      setErrors([]);
      setDirty(false);
      setNotice("Draft saved. Publish it to use it on calls.");
      await qc.invalidateQueries({ queryKey: ["agent", id] });
    },
    onError: (e) => setErrors(e instanceof ApiError ? e.fieldErrors : []),
  });
  const publish = useMutation({
    mutationFn: () => api<{ version: number }>(`/agents/${id}/publish`, { method: "POST" }),
    onSuccess: async (v) => {
      setNotice(`Version ${v.version} is live. New calls use it now.`);
      await qc.invalidateQueries({ queryKey: ["agent", id] });
      await qc.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  const collectKeys = useMemo(
    () =>
      new Set(
        (config?.workflow.steps ?? []).flatMap((s) => (s.type === "collect_fields" ? (s.fields ?? []) : [])),
      ),
    [config],
  );

  if (agent.error) return <Alert>{errorMessage(agent.error)}</Alert>;
  if (!agent.data || !config) return <p className="text-sm text-slate-500">Loading…</p>;
  const a = agent.data;
  const readOnly = !canWrite;

  const setField = (i: number, patch: Partial<FieldJson>) =>
    update((c) => {
      c.qualificationFields[i] = { ...c.qualificationFields[i]!, ...patch };
    });
  const addField = () =>
    update((c) => {
      const keys = new Set(c.qualificationFields.map((f) => f.key));
      let key = "new_question";
      for (let n = 2; keys.has(key); n++) key = `new_question_${n}`;
      c.qualificationFields.push({
        key,
        label: "New question",
        question: "What would you like to ask?",
        type: "text",
        options: [],
        required: true,
      });
      // New questions are asked in the first data-collection step
      const step = c.workflow.steps.find((s) => s.type === "collect_fields");
      step?.fields?.push(key);
    });
  const removeField = (i: number) =>
    update((c) => {
      const [removed] = c.qualificationFields.splice(i, 1);
      for (const s of c.workflow.steps) {
        if (s.fields) s.fields = s.fields.filter((k) => k !== removed!.key);
        if (s.resetOnDecline) s.resetOnDecline = s.resetOnDecline.filter((k) => k !== removed!.key);
      }
    });
  const moveField = (i: number, dir: -1 | 1) =>
    update((c) => {
      const f = c.qualificationFields;
      const j = i + dir;
      if (j < 0 || j >= f.length) return;
      [f[i], f[j]] = [f[j]!, f[i]!];
      const key = f[i]!.key;
      const other = f[j]!.key;
      for (const s of c.workflow.steps) {
        if (!s.fields) continue;
        const a1 = s.fields.indexOf(key);
        const b1 = s.fields.indexOf(other);
        if (a1 >= 0 && b1 >= 0) [s.fields[a1], s.fields[b1]] = [s.fields[b1]!, s.fields[a1]!];
      }
    });
  const errorFor = (path: string) => errors.find((e) => e.path === `config.${path}`)?.message;

  return (
    <>
      <PageHeader
        title={a.name}
        description={
          a.published
            ? `Live: version ${a.published.version}${a.draft ? ` · editing draft v${a.draft.version}` : ""}`
            : "Not published yet"
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill value={a.status} />
            {canWrite ? (
              <Button
                variant="secondary"
                loading={save.isPending}
                disabled={!dirty}
                onClick={() => save.mutate()}
              >
                Save draft
              </Button>
            ) : null}
            {canPublish ? (
              <Button
                loading={publish.isPending}
                disabled={dirty || !a.draft}
                onClick={() => publish.mutate()}
                title={dirty ? "Save your changes first" : undefined}
              >
                Publish
              </Button>
            ) : null}
          </div>
        }
      />
      <div className="mb-4 space-y-2">
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {publish.error ? <Alert>{errorMessage(publish.error)}</Alert> : null}
        {errors.length ? (
          <Alert>
            Fix these before saving:
            <ul className="mt-1 list-disc pl-5">
              {errors.map((e) => (
                <li key={e.path + e.message}>
                  <code className="text-xs">{e.path.replace(/^config\./, "")}</code>: {e.message}
                </li>
              ))}
            </ul>
          </Alert>
        ) : save.error ? (
          <Alert>{errorMessage(save.error)}</Alert>
        ) : null}
        {!a.phoneNumbers.length ? (
          <Alert tone="info">
            No phone number routes to this agent yet.{" "}
            <Link className="font-medium underline" href={`/t/${me.tenant.slug}/settings/phone-numbers`}>
              Connect a number
            </Link>
          </Alert>
        ) : null}
      </div>

      <fieldset disabled={readOnly} className="space-y-6">
        <Card>
          <h2 className="font-semibold">Identity</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <TextField
              label="Business name (spoken)"
              value={config.businessName}
              error={errorFor("businessName")}
              onChange={(e) => update((c) => void (c.businessName = e.target.value))}
            />
            <TextField
              label="Agent introduces itself as"
              value={config.agentName}
              error={errorFor("agentName")}
              onChange={(e) => update((c) => void (c.agentName = e.target.value))}
            />
            <TextField
              className="md:col-span-2"
              label="Greeting"
              value={config.greeting}
              error={errorFor("greeting")}
              hint="Use {{agent_name}} and {{business_name}} as placeholders."
              onChange={(e) => update((c) => void (c.greeting = e.target.value))}
            />
          </div>
        </Card>

        <Card>
          <h2 className="font-semibold">Behaviour</h2>
          <div className="mt-4 grid gap-4">
            <label className="block text-sm font-medium">
              Personality
              <textarea
                className={`${textarea} mt-1.5`}
                rows={2}
                value={config.persona}
                onChange={(e) => update((c) => void (c.persona = e.target.value))}
              />
            </label>
            <label className="block text-sm font-medium">
              Instructions
              <textarea
                className={`${textarea} mt-1.5`}
                rows={3}
                value={config.instructions}
                onChange={(e) => update((c) => void (c.instructions = e.target.value))}
              />
            </label>
            <label className="block text-sm font-medium">
              Business rules <span className="font-normal text-slate-500">(one per line)</span>
              <textarea
                className={`${textarea} mt-1.5`}
                rows={4}
                value={config.businessRules.join("\n")}
                onChange={(e) =>
                  update(
                    (c) =>
                      void (c.businessRules = e.target.value
                        .split("\n")
                        .map((l) => l.trim())
                        .filter(Boolean)),
                  )
                }
              />
            </label>
          </div>
        </Card>

        <Card>
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="font-semibold">Qualification questions</h2>
              <p className="text-sm text-slate-500">What the agent collects on every call, in this order.</p>
            </div>
            {!readOnly ? (
              <Button type="button" variant="secondary" onClick={addField}>
                Add question
              </Button>
            ) : null}
          </div>
          <ol className="mt-4 space-y-4">
            {config.qualificationFields.map((f, i) => {
              const isNew =
                !source?.config.qualificationFields.some((o) => o.key === f.key) ||
                f.key.startsWith("new_question");
              return (
                <li key={i} className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
                  <div className="grid gap-3 md:grid-cols-[1fr_1fr_160px]">
                    <TextField
                      label="Label"
                      value={f.label}
                      error={errorFor(`qualificationFields.${i}.label`)}
                      onChange={(e) => setField(i, { label: e.target.value })}
                      onBlur={() => {
                        if (isNew && f.key.startsWith("new_question")) {
                          const key = slug(f.label);
                          update((c) => {
                            const old = c.qualificationFields[i]!.key;
                            if (c.qualificationFields.some((o, j) => j !== i && o.key === key)) return;
                            c.qualificationFields[i]!.key = key;
                            for (const s of c.workflow.steps)
                              if (s.fields) s.fields = s.fields.map((k) => (k === old ? key : k));
                          });
                        }
                      }}
                    />
                    <SelectField
                      label="Answer type"
                      value={f.type}
                      onChange={(e) =>
                        setField(i, {
                          type: e.target.value,
                          ...(e.target.value.includes("select") ? {} : { options: [] }),
                        })
                      }
                    >
                      {FIELD_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </SelectField>
                    <label className="flex items-center gap-2 text-sm md:mt-7">
                      <input
                        type="checkbox"
                        checked={f.required}
                        onChange={(e) => setField(i, { required: e.target.checked })}
                      />{" "}
                      Required
                    </label>
                    <TextField
                      className="md:col-span-3"
                      label="Question the agent asks"
                      value={f.question}
                      error={errorFor(`qualificationFields.${i}.question`)}
                      onChange={(e) => setField(i, { question: e.target.value })}
                    />
                    {f.type === "select" || f.type === "multiselect" ? (
                      <TextField
                        className="md:col-span-3"
                        label="Options (comma separated)"
                        value={f.options.join(", ")}
                        error={errorFor(`qualificationFields.${i}.options`)}
                        onChange={(e) =>
                          setField(i, {
                            options: e.target.value
                              .split(",")
                              .map((o) => o.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    ) : null}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <code>{f.key}</code>
                    {!collectKeys.has(f.key) ? <span>· not asked by the workflow</span> : null}
                    {!readOnly ? (
                      <span className="ml-auto flex gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-8 px-2"
                          onClick={() => moveField(i, -1)}
                          aria-label={`Move ${f.label} up`}
                        >
                          ↑
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-8 px-2"
                          onClick={() => moveField(i, 1)}
                          aria-label={`Move ${f.label} down`}
                        >
                          ↓
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-8 px-2 text-red-600"
                          onClick={() => removeField(i)}
                        >
                          Remove
                        </Button>
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </Card>

        <Card>
          <h2 className="font-semibold">Workflow</h2>
          <p className="text-sm text-slate-500">
            The steps of the call. A visual step editor arrives in the next release.
          </p>
          <ol className="mt-3 space-y-1 text-sm">
            {config.workflow.steps.map((s, i) => (
              <li key={s.id} className="flex gap-2">
                <span className="w-6 text-right text-slate-400">{i + 1}.</span>
                <span className="font-medium">{s.type.replace(/_/g, " ")}</span>
                <span className="text-slate-500">
                  {s.fields ? s.fields.join(", ") : String(s.tool ?? s.action ?? s.text ?? s.message ?? "")}
                </span>
              </li>
            ))}
          </ol>
        </Card>
      </fieldset>
    </>
  );
}
