"use client";

import type { AgentConfig, QualificationField } from "@platform/shared";
import { FieldType } from "@platform/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Check, Section, TextArea } from "@/components/ui/inputs";
import { slugKey, useDraft } from "./draft-context";

const TYPE_LABELS: Record<string, string> = {
  text: "Free text",
  name: "Person's name",
  number: "Number",
  currency: "Amount of money",
  select: "One choice",
  multiselect: "Several choices",
  boolean: "Yes / no",
  date: "Date",
  time: "Time",
  phone: "Phone number",
  email: "Email",
};

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Rename a field key everywhere the workflow refers to it */
function renameKey(c: AgentConfig, from: string, to: string) {
  for (const s of c.workflow.steps) {
    if (s.type === "collect_fields") s.fields = s.fields.map((k) => (k === from ? to : k));
    if (s.type === "confirm_and_act") s.resetOnDecline = s.resetOnDecline.map((k) => (k === from ? to : k));
    if (s.type === "branch")
      for (const r of s.rules) for (const cond of r.when) if (cond.field === from) cond.field = to;
  }
}

export function QuestionsTab() {
  const { config, update, errorFor } = useDraft();
  const [open, setOpen] = useState<number | null>(null);

  const add = () =>
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
        currency: "INR",
        validation: {},
        reaskPrompts: [],
        confirmBack: false,
        hints: [],
      });
      const step = c.workflow.steps.find((s) => s.type === "collect_fields");
      if (step?.type === "collect_fields") step.fields.push(key);
    });

  const remove = (i: number) =>
    update((c) => {
      const [gone] = c.qualificationFields.splice(i, 1);
      for (const s of c.workflow.steps) {
        if (s.type === "collect_fields") s.fields = s.fields.filter((k) => k !== gone!.key);
        if (s.type === "confirm_and_act") s.resetOnDecline = s.resetOnDecline.filter((k) => k !== gone!.key);
      }
    });

  const move = (i: number, dir: -1 | 1) =>
    update((c) => {
      const f = c.qualificationFields;
      const j = i + dir;
      if (j < 0 || j >= f.length) return;
      [f[i], f[j]] = [f[j]!, f[i]!];
      // Keep each collect step asking in the same relative order as the list
      const order = new Map(f.map((x, idx) => [x.key, idx]));
      for (const s of c.workflow.steps)
        if (s.type === "collect_fields") s.fields.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    });

  const set = (i: number, fn: (f: QualificationField) => void) =>
    update((c) => fn(c.qualificationFields[i]!));
  const asked = new Set(config.workflow.steps.flatMap((s) => (s.type === "collect_fields" ? s.fields : [])));

  return (
    <Section
      title="Qualification questions"
      description="What the agent collects. Answers are checked against these rules before they are saved."
      actions={<Button onClick={add}>Add question</Button>}
    >
      <ol className="space-y-4">
        {config.qualificationFields.map((f, i) => {
          const err = (p: string) => errorFor(`qualificationFields.${i}.${p}`);
          const isChoice = f.type === "select" || f.type === "multiselect";
          const isNumber = f.type === "number" || f.type === "currency";
          return (
            <li key={i} className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
              <div className="grid gap-3 md:grid-cols-[1fr_200px_auto]">
                <TextField
                  label="Label"
                  value={f.label}
                  error={err("label")}
                  onChange={(e) => set(i, (x) => void (x.label = e.target.value))}
                  onBlur={() => {
                    if (!f.key.startsWith("new_question")) return;
                    const key = slugKey(f.label);
                    if (config.qualificationFields.some((o, j) => j !== i && o.key === key)) return;
                    update((c) => {
                      renameKey(c, c.qualificationFields[i]!.key, key);
                      c.qualificationFields[i]!.key = key;
                    });
                  }}
                />
                <SelectField
                  label="Answer type"
                  value={f.type}
                  onChange={(e) =>
                    set(i, (x) => {
                      x.type = e.target.value as QualificationField["type"];
                      if (!x.type.includes("select")) x.options = [];
                    })
                  }
                >
                  {FieldType.options.map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABELS[t] ?? t}
                    </option>
                  ))}
                </SelectField>
                <div className="flex items-center gap-4 md:mt-7">
                  <Check
                    label="Required"
                    checked={f.required}
                    onChange={(v) => set(i, (x) => void (x.required = v))}
                  />
                </div>
                <TextField
                  className="md:col-span-3"
                  label="Question the agent asks"
                  value={f.question}
                  error={err("question")}
                  onChange={(e) => set(i, (x) => void (x.question = e.target.value))}
                />
                {isChoice ? (
                  <TextField
                    className="md:col-span-3"
                    label="Options (comma separated)"
                    value={f.options.join(", ")}
                    error={err("options")}
                    onChange={(e) =>
                      set(
                        i,
                        (x) =>
                          void (x.options = e.target.value
                            .split(",")
                            .map((o) => o.trim())
                            .filter(Boolean)),
                      )
                    }
                  />
                ) : null}
              </div>

              {open === i ? (
                <div className="mt-4 grid gap-3 border-t border-slate-100 pt-4 md:grid-cols-2 dark:border-slate-800">
                  {isNumber ? (
                    <>
                      <TextField
                        label="Minimum"
                        type="number"
                        value={f.validation.min ?? ""}
                        onChange={(e) =>
                          set(
                            i,
                            (x) =>
                              void (x.validation.min =
                                e.target.value === "" ? undefined : Number(e.target.value)),
                          )
                        }
                      />
                      <TextField
                        label="Maximum"
                        type="number"
                        value={f.validation.max ?? ""}
                        error={err("validation.min")}
                        onChange={(e) =>
                          set(
                            i,
                            (x) =>
                              void (x.validation.max =
                                e.target.value === "" ? undefined : Number(e.target.value)),
                          )
                        }
                      />
                    </>
                  ) : null}
                  {f.type === "currency" ? (
                    <TextField
                      label="Currency"
                      value={f.currency}
                      error={err("currency")}
                      onChange={(e) => set(i, (x) => void (x.currency = e.target.value.toUpperCase()))}
                    />
                  ) : null}
                  {f.type === "text" ? (
                    <TextField
                      label="Must match (regular expression)"
                      value={f.validation.pattern ?? ""}
                      error={err("validation.pattern")}
                      onChange={(e) =>
                        set(i, (x) => void (x.validation.pattern = e.target.value || undefined))
                      }
                    />
                  ) : null}
                  {f.type === "date" ? (
                    <div className="md:mt-7">
                      <Check
                        label="Only today or later"
                        checked={Boolean(f.validation.futureOnly)}
                        onChange={(v) => set(i, (x) => void (x.validation.futureOnly = v || undefined))}
                      />
                    </div>
                  ) : null}
                  <TextArea
                    className="md:col-span-2"
                    label="If the answer is unclear, ask again with (one per line, up to 3)"
                    rows={2}
                    value={f.reaskPrompts.join("\n")}
                    error={err("reaskPrompts")}
                    onChange={(e) => set(i, (x) => void (x.reaskPrompts = lines(e.target.value).slice(0, 3)))}
                  />
                  <TextField
                    className="md:col-span-2"
                    label="Speech recognition hints (comma separated)"
                    hint="Names and words callers are likely to say, e.g. neighbourhoods or product names."
                    value={f.hints.join(", ")}
                    onChange={(e) =>
                      set(
                        i,
                        (x) =>
                          void (x.hints = e.target.value
                            .split(",")
                            .map((h) => h.trim())
                            .filter(Boolean)),
                      )
                    }
                  />
                  <Check
                    label="Read the answer back to the caller"
                    checked={f.confirmBack}
                    onChange={(v) => set(i, (x) => void (x.confirmBack = v))}
                  />
                </div>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <code>{f.key}</code>
                {!asked.has(f.key) ? (
                  <span className="text-amber-700 dark:text-amber-300">· not asked by any workflow step</span>
                ) : null}
                {err("key") ? <span className="text-red-600">· {err("key")}</span> : null}
                <span className="ml-auto flex gap-1">
                  <Button
                    variant="ghost"
                    className="h-8 px-2"
                    onClick={() => setOpen(open === i ? null : i)}
                    aria-expanded={open === i}
                  >
                    {open === i ? "Fewer options" : "More options"}
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-8 px-2"
                    onClick={() => move(i, -1)}
                    aria-label={`Move ${f.label} up`}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-8 px-2"
                    onClick={() => move(i, 1)}
                    aria-label={`Move ${f.label} down`}
                  >
                    ↓
                  </Button>
                  <Button variant="ghost" className="h-8 px-2 text-red-600" onClick={() => remove(i)}>
                    Remove
                  </Button>
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
