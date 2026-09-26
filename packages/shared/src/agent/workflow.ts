import { z } from "zod";
import { FieldKey } from "./fields";
import { ToolName } from "./tools";

export const StepId = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "lowercase_snake_case");

/** Text with {{field_key}} placeholders, filled from collected values */
export const Template = z.string().trim().min(1).max(500);

export const ConditionOp = z.enum(["eq", "neq", "in", "gt", "gte", "lt", "lte", "exists", "not_exists"]);
export const Condition = z
  .object({
    field: FieldKey,
    op: ConditionOp,
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
  })
  .superRefine((c, ctx) => {
    const needsValue = !["exists", "not_exists"].includes(c.op);
    if (needsValue && c.value === undefined)
      ctx.addIssue({ code: "custom", path: ["value"], message: "value required" });
    if (c.op === "in" && !Array.isArray(c.value))
      ctx.addIssue({ code: "custom", path: ["value"], message: "`in` needs a list" });
  });
export type Condition = z.infer<typeof Condition>;

const base = { id: StepId };

/** Tool arguments: literal values or {{field_key}} templates */
const ToolInput = z
  .record(z.string().max(60), z.union([z.string().max(500), z.number(), z.boolean()]))
  .default({});

export const WorkflowStep = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("greeting") }),
  z.object({ ...base, type: z.literal("collect_fields"), fields: z.array(FieldKey).min(1).max(30) }),
  z.object({ ...base, type: z.literal("say"), text: Template }),
  z.object({
    ...base,
    type: z.literal("tool"),
    tool: ToolName,
    input: ToolInput,
    /** Run without waiting (exports, notifications); the call never blocks on it */
    background: z.boolean().default(false),
    /** Step to continue with when the tool fails (default: next step) */
    onError: StepId.optional(),
  }),
  z.object({
    ...base,
    type: z.literal("confirm_and_act"),
    /** Question read to the caller, e.g. "Shall I book {{preferred_date}} at {{preferred_time}}?" */
    message: Template,
    action: ToolName,
    input: ToolInput,
    successMessage: Template.optional(),
    /** On "no": clear these fields and continue at `onDecline` (default: the previous collect step) */
    resetOnDecline: z.array(FieldKey).default([]),
    onDecline: StepId.optional(),
    onError: StepId.optional(),
  }),
  z.object({
    ...base,
    type: z.literal("branch"),
    rules: z
      .array(z.object({ when: z.array(Condition).min(1), goto: StepId }))
      .min(1)
      .max(20),
    otherwise: StepId.optional(),
  }),
  z.object({ ...base, type: z.literal("handoff"), reason: z.string().max(200).optional() }),
  z.object({ ...base, type: z.literal("end"), text: Template.optional() }),
]);
export type WorkflowStep = z.infer<typeof WorkflowStep>;

export const WorkflowDefinition = z.object({
  steps: z.array(WorkflowStep).min(2).max(60),
  /** Answer caller questions from the knowledge base at any point in the flow */
  answerQuestions: z.boolean().default(true),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;
