"use client";

import { type AgentConfig, type Condition, TOOL_NAMES, type WorkflowStep } from "@platform/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Check, Section } from "@/components/ui/inputs";
import { useDraft } from "./draft-context";

type StepType = WorkflowStep["type"];

const STEP_INFO: Record<StepType, { label: string; help: string }> = {
  greeting: { label: "Greeting", help: "Says the greeting once." },
  collect_fields: { label: "Ask questions", help: "Asks each selected question that is still unanswered." },
  say: { label: "Say", help: "Says a sentence and moves on." },
  tool: { label: "Run a tool", help: "Saves a lead, sends a message, etc." },
  confirm_and_act: {
    label: "Confirm, then act",
    help: "Reads back details, and on “yes” runs an action such as booking.",
  },
  branch: { label: "Branch", help: "Jumps to another step when conditions match." },
  handoff: {
    label: "Transfer to a person",
    help: "Transfers the call during working hours, otherwise takes a message.",
  },
  end: { label: "End call", help: "Says goodbye and hangs up." },
};

/** Tools the platform can run today; others need an integration (next phase) */
const AVAILABLE_NOW = new Set(["leads.create", "appointments.create"]);
const OPS: Condition["op"][] = ["eq", "neq", "in", "gt", "gte", "lt", "lte", "exists", "not_exists"];
const OP_LABEL: Record<Condition["op"], string> = {
  eq: "is",
  neq: "is not",
  in: "is one of",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  exists: "was answered",
  not_exists: "was not answered",
};

function newStep(type: StepType, id: string, c: AgentConfig): WorkflowStep {
  const tool = c.tools[0] ?? "leads.create";
  switch (type) {
    case "greeting":
    case "handoff":
      return { id, type } as WorkflowStep;
    case "collect_fields":
      return { id, type, fields: c.qualificationFields.slice(0, 1).map((f) => f.key) };
    case "say":
      return { id, type, text: "Thank you." };
    case "end":
      return { id, type };
    case "tool":
      return { id, type, tool, input: {}, background: true };
    case "confirm_and_act":
      return { id, type, message: "Shall I go ahead?", action: tool, input: {}, resetOnDecline: [] };
    case "branch":
      return {
        id,
        type,
        rules: [
          {
            when: [{ field: c.qualificationFields[0]?.key ?? "x", op: "exists" }],
            goto: c.workflow.steps.at(-1)?.id ?? "end",
          },
        ],
      };
  }
}

export function WorkflowTab() {
  const { config, update, errorFor } = useDraft();
  const [adding, setAdding] = useState<StepType>("collect_fields");
  const steps = config.workflow.steps;

  const addStep = () =>
    update((c) => {
      const ids = new Set(c.workflow.steps.map((s) => s.id));
      let id: string = adding;
      for (let n = 2; ids.has(id); n++) id = `${adding}_${n}`;
      // Insert before the final end/handoff step so the workflow still finishes properly
      const at = Math.max(0, c.workflow.steps.length - 1);
      c.workflow.steps.splice(at, 0, newStep(adding, id, c));
    });

  return (
    <div className="space-y-6">
      <Section
        title="Tools"
        description="Actions this agent may perform. Anything not ticked can never run, whatever the conversation."
      >
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {TOOL_NAMES.map((t) => (
            <Check
              key={t}
              label={
                <>
                  <code className="text-xs">{t}</code>
                  {!AVAILABLE_NOW.has(t) ? (
                    <span className="ml-1 text-xs text-amber-700 dark:text-amber-300">
                      needs an integration
                    </span>
                  ) : null}
                </>
              }
              checked={config.tools.includes(t)}
              onChange={(v) =>
                update((c) => void (c.tools = v ? [...c.tools, t] : c.tools.filter((x) => x !== t)))
              }
            />
          ))}
        </div>
        {errorFor("tools") ? <p className="mt-2 text-sm text-red-600">{errorFor("tools")}</p> : null}
      </Section>

      <Section
        title="Workflow"
        description="The call runs these steps in order. Questions asked by the caller are answered at any point."
        actions={
          <div className="flex items-end gap-2">
            <SelectField
              label="New step"
              value={adding}
              onChange={(e) => setAdding(e.target.value as StepType)}
            >
              {(Object.keys(STEP_INFO) as StepType[]).map((t) => (
                <option key={t} value={t}>
                  {STEP_INFO[t].label}
                </option>
              ))}
            </SelectField>
            <Button variant="secondary" onClick={addStep}>
              Add
            </Button>
          </div>
        }
      >
        <ol className="space-y-3">
          {steps.map((step, i) => (
            <StepCard key={`${i}-${step.type}`} step={step} index={i} />
          ))}
        </ol>
        {errorFor(`workflow.steps.${steps.length - 1}`) ? (
          <p className="mt-2 text-sm text-red-600">{errorFor(`workflow.steps.${steps.length - 1}`)}</p>
        ) : null}
      </Section>
    </div>
  );
}

function StepCard({ step, index: i }: { step: WorkflowStep; index: number }) {
  const { config, update, errorFor } = useDraft();
  const steps = config.workflow.steps;
  const set = (fn: (s: WorkflowStep) => void) => update((c) => fn(c.workflow.steps[i]!));
  const err = (p: string) => errorFor(`workflow.steps.${i}.${p}`);
  const stepOptions = (blankLabel: string) => [
    <option key="" value="">
      {blankLabel}
    </option>,
    ...steps
      .filter((s) => s.id !== step.id)
      .map((s) => (
        <option key={s.id} value={s.id}>
          {s.id} ({STEP_INFO[s.type].label})
        </option>
      )),
  ];
  const toolOptions = config.tools.map((t) => (
    <option key={t} value={t}>
      {t}
    </option>
  ));

  const move = (dir: -1 | 1) =>
    update((c) => {
      const j = i + dir;
      const s = c.workflow.steps;
      if (j < 0 || j >= s.length) return;
      [s[i], s[j]] = [s[j]!, s[i]!];
    });
  const remove = () => update((c) => void c.workflow.steps.splice(i, 1));

  return (
    <li className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold dark:bg-slate-800">
          {i + 1}. {STEP_INFO[step.type].label}
        </span>
        <input
          aria-label="Step id"
          value={step.id}
          onChange={(e) => set((s) => void (s.id = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_")))}
          className="h-8 w-44 rounded-md border border-slate-300 bg-white px-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
        />
        <span className="text-xs text-slate-500">{STEP_INFO[step.type].help}</span>
        <span className="ml-auto flex gap-1">
          <Button
            variant="ghost"
            className="h-8 px-2"
            onClick={() => move(-1)}
            aria-label={`Move step ${step.id} up`}
          >
            ↑
          </Button>
          <Button
            variant="ghost"
            className="h-8 px-2"
            onClick={() => move(1)}
            aria-label={`Move step ${step.id} down`}
          >
            ↓
          </Button>
          <Button variant="ghost" className="h-8 px-2 text-red-600" onClick={remove}>
            Remove
          </Button>
        </span>
      </div>
      {err("id") ? <p className="mb-2 text-sm text-red-600">{err("id")}</p> : null}

      {step.type === "collect_fields" ? (
        <fieldset>
          <legend className="mb-1 text-sm font-medium">Questions to ask</legend>
          <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {config.qualificationFields.map((f) => (
              <Check
                key={f.key}
                label={f.label}
                checked={step.fields.includes(f.key)}
                onChange={(v) =>
                  set((s) => {
                    if (s.type !== "collect_fields") return;
                    const order = config.qualificationFields.map((x) => x.key);
                    const next = v ? [...s.fields, f.key] : s.fields.filter((k) => k !== f.key);
                    s.fields = order.filter((k) => next.includes(k));
                  })
                }
              />
            ))}
          </div>
          {err("fields") ? <p className="mt-1 text-sm text-red-600">{err("fields")}</p> : null}
        </fieldset>
      ) : null}

      {step.type === "say" ? (
        <TextField
          label="Text"
          value={step.text}
          error={err("text")}
          onChange={(e) => set((s) => void (s.type === "say" && (s.text = e.target.value)))}
        />
      ) : null}

      {step.type === "end" ? (
        <TextField
          label="Goodbye (optional)"
          value={step.text ?? ""}
          error={err("text")}
          hint="Leave empty to use the standard goodbye."
          onChange={(e) => set((s) => void (s.type === "end" && (s.text = e.target.value || undefined)))}
        />
      ) : null}

      {step.type === "handoff" ? (
        <TextField
          label="Reason (for the team)"
          value={step.reason ?? ""}
          onChange={(e) =>
            set((s) => void (s.type === "handoff" && (s.reason = e.target.value || undefined)))
          }
        />
      ) : null}

      {step.type === "tool" ? (
        <div className="grid gap-3 md:grid-cols-3">
          <SelectField
            label="Tool"
            value={step.tool}
            error={err("tool")}
            onChange={(e) =>
              set((s) => void (s.type === "tool" && (s.tool = e.target.value as typeof s.tool)))
            }
          >
            {toolOptions}
          </SelectField>
          <SelectField
            label="If it fails, continue at"
            value={step.onError ?? ""}
            error={err("onError")}
            onChange={(e) =>
              set((s) => void (s.type === "tool" && (s.onError = e.target.value || undefined)))
            }
          >
            {stepOptions("The next step")}
          </SelectField>
          <div className="md:mt-7">
            <Check
              label="Run in the background"
              hint="The caller never waits for it"
              checked={step.background}
              onChange={(v) => set((s) => void (s.type === "tool" && (s.background = v)))}
            />
          </div>
          <ToolInputEditor
            className="md:col-span-3"
            value={step.input}
            onChange={(input) => set((s) => void (s.type === "tool" && (s.input = input)))}
          />
        </div>
      ) : null}

      {step.type === "confirm_and_act" ? (
        <div className="grid gap-3 md:grid-cols-3">
          <TextField
            className="md:col-span-3"
            label="Confirmation question"
            value={step.message}
            error={err("message")}
            onChange={(e) => set((s) => void (s.type === "confirm_and_act" && (s.message = e.target.value)))}
          />
          <SelectField
            label="On “yes”, run"
            value={step.action}
            error={err("action")}
            onChange={(e) =>
              set(
                (s) => void (s.type === "confirm_and_act" && (s.action = e.target.value as typeof s.action)),
              )
            }
          >
            {toolOptions}
          </SelectField>
          <SelectField
            label="On “no”, go back to"
            value={step.onDecline ?? ""}
            error={err("onDecline")}
            onChange={(e) =>
              set((s) => void (s.type === "confirm_and_act" && (s.onDecline = e.target.value || undefined)))
            }
          >
            {stepOptions("The previous question step")}
          </SelectField>
          <SelectField
            label="If the action fails, continue at"
            value={step.onError ?? ""}
            error={err("onError")}
            onChange={(e) =>
              set((s) => void (s.type === "confirm_and_act" && (s.onError = e.target.value || undefined)))
            }
          >
            {stepOptions("The next step")}
          </SelectField>
          <TextField
            className="md:col-span-3"
            label="Say after success (optional)"
            value={step.successMessage ?? ""}
            error={err("successMessage")}
            onChange={(e) =>
              set(
                (s) =>
                  void (s.type === "confirm_and_act" && (s.successMessage = e.target.value || undefined)),
              )
            }
          />
          <fieldset className="md:col-span-3">
            <legend className="mb-1 text-sm font-medium">On “no”, ask these again</legend>
            <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
              {config.qualificationFields.map((f) => (
                <Check
                  key={f.key}
                  label={f.label}
                  checked={step.resetOnDecline.includes(f.key)}
                  onChange={(v) =>
                    set((s) => {
                      if (s.type !== "confirm_and_act") return;
                      s.resetOnDecline = v
                        ? [...s.resetOnDecline, f.key]
                        : s.resetOnDecline.filter((k) => k !== f.key);
                    })
                  }
                />
              ))}
            </div>
          </fieldset>
          <ToolInputEditor
            className="md:col-span-3"
            value={step.input}
            onChange={(input) => set((s) => void (s.type === "confirm_and_act" && (s.input = input)))}
          />
        </div>
      ) : null}

      {step.type === "branch" ? <BranchEditor index={i} /> : null}
    </li>
  );
}

function ToolInputEditor({
  value,
  onChange,
  className,
}: {
  value: Record<string, string | number | boolean>;
  onChange: (v: Record<string, string | number | boolean>) => void;
  className?: string;
}) {
  const rows = Object.entries(value);
  return (
    <fieldset className={className}>
      <legend className="mb-1 text-sm font-medium">Tool inputs</legend>
      <p className="mb-2 text-xs text-slate-500">
        Values may use {"{{question_key}}"}. Everything collected is always sent too.
      </p>
      <div className="space-y-2">
        {rows.map(([k, v], idx) => (
          <div key={idx} className="flex gap-2">
            <input
              aria-label="Input name"
              value={k}
              onChange={(e) =>
                onChange(
                  Object.fromEntries(
                    rows.map(([rk, rv], j) => (j === idx ? [e.target.value, rv] : [rk, rv])),
                  ),
                )
              }
              className="h-9 w-40 rounded-md border border-slate-300 bg-white px-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
            />
            <input
              aria-label={`Value for ${k}`}
              value={String(v)}
              onChange={(e) => onChange({ ...value, [k]: e.target.value })}
              className="h-9 flex-1 rounded-md border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
            />
            <Button
              variant="ghost"
              className="h-9 px-2"
              onClick={() => onChange(Object.fromEntries(rows.filter((_, j) => j !== idx)))}
              aria-label={`Remove input ${k}`}
            >
              ✕
            </Button>
          </div>
        ))}
        <Button
          variant="ghost"
          className="h-8 px-2"
          onClick={() => onChange({ ...value, [`input_${rows.length + 1}`]: "" })}
        >
          + Add input
        </Button>
      </div>
    </fieldset>
  );
}

function BranchEditor({ index: i }: { index: number }) {
  const { config, update, errorFor } = useDraft();
  const step = config.workflow.steps[i];
  if (step?.type !== "branch") return null;
  const fields = config.qualificationFields;
  const set = (fn: (s: Extract<WorkflowStep, { type: "branch" }>) => void) =>
    update((c) => {
      const s = c.workflow.steps[i];
      if (s?.type === "branch") fn(s);
    });
  const others = config.workflow.steps.filter((s) => s.id !== step.id);

  const valueInput = (cond: Condition, onValue: (v: Condition["value"]) => void) => {
    if (cond.op === "exists" || cond.op === "not_exists") return null;
    const f = fields.find((x) => x.key === cond.field);
    if (f && (f.type === "select" || f.type === "boolean") && cond.op !== "in") {
      const opts = f.type === "boolean" ? ["true", "false"] : f.options;
      return (
        <select
          aria-label="Value"
          value={String(cond.value ?? "")}
          onChange={(e) => onValue(f.type === "boolean" ? e.target.value === "true" : e.target.value)}
          className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
        >
          <option value="" disabled>
            Choose…
          </option>
          {opts.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    }
    const numeric = f?.type === "number" || f?.type === "currency";
    return (
      <input
        aria-label="Value"
        value={Array.isArray(cond.value) ? cond.value.join(", ") : String(cond.value ?? "")}
        placeholder={cond.op === "in" ? "a, b, c" : "value"}
        onChange={(e) => {
          const raw = e.target.value;
          onValue(
            cond.op === "in"
              ? raw
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean)
              : numeric && raw !== "" && !Number.isNaN(Number(raw))
                ? Number(raw)
                : raw,
          );
        }}
        className="h-9 w-40 rounded-md border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
      />
    );
  };

  return (
    <div className="space-y-3">
      {step.rules.map((rule, r) => (
        <div key={r} className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50">
          <p className="mb-2 text-xs font-semibold text-slate-500 uppercase">{r === 0 ? "If" : "Else if"}</p>
          {rule.when.map((cond, k) => (
            <div key={k} className="mb-2 flex flex-wrap items-center gap-2">
              {k > 0 ? <span className="text-xs text-slate-500">and</span> : null}
              <select
                aria-label="Question"
                value={cond.field}
                onChange={(e) => set((s) => void (s.rules[r]!.when[k]!.field = e.target.value))}
                className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
              >
                {fields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="Operator"
                value={cond.op}
                onChange={(e) =>
                  set((s) => {
                    const c = s.rules[r]!.when[k]!;
                    c.op = e.target.value as Condition["op"];
                    if (c.op === "exists" || c.op === "not_exists") delete c.value;
                    if (c.op === "in" && !Array.isArray(c.value)) c.value = [];
                  })
                }
                className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
              >
                {OPS.map((o) => (
                  <option key={o} value={o}>
                    {OP_LABEL[o]}
                  </option>
                ))}
              </select>
              {valueInput(cond, (v) => set((s) => void (s.rules[r]!.when[k]!.value = v)))}
              <Button
                variant="ghost"
                className="h-9 px-2"
                onClick={() => set((s) => void s.rules[r]!.when.splice(k, 1))}
                aria-label="Remove condition"
              >
                ✕
              </Button>
            </div>
          ))}
          {errorFor(`workflow.steps.${i}.rules.${r}.when`) ? (
            <p className="text-sm text-red-600">{errorFor(`workflow.steps.${i}.rules.${r}.when`)}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              className="h-8 px-2"
              onClick={() =>
                set((s) => void s.rules[r]!.when.push({ field: fields[0]?.key ?? "", op: "exists" }))
              }
            >
              + Condition
            </Button>
            <span className="text-sm">then go to</span>
            <select
              aria-label="Go to step"
              value={rule.goto}
              onChange={(e) => set((s) => void (s.rules[r]!.goto = e.target.value))}
              className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
            >
              {others.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id}
                </option>
              ))}
            </select>
            <Button
              variant="ghost"
              className="h-8 px-2 text-red-600"
              onClick={() => set((s) => void s.rules.splice(r, 1))}
            >
              Remove rule
            </Button>
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          onClick={() =>
            set(
              (s) =>
                void s.rules.push({
                  when: [{ field: fields[0]?.key ?? "", op: "exists" }],
                  goto: others.at(-1)?.id ?? "",
                }),
            )
          }
        >
          Add rule
        </Button>
        <span className="text-sm">Otherwise go to</span>
        <select
          aria-label="Otherwise go to"
          value={step.otherwise ?? ""}
          onChange={(e) => set((s) => void (s.otherwise = e.target.value || undefined))}
          className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
        >
          <option value="">The next step</option>
          {others.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
