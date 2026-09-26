import { z } from "zod";

export const FieldType = z.enum([
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
]);
export type FieldType = z.infer<typeof FieldType>;

export const FieldKey = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, "lowercase_snake_case, 2–40 characters");

/**
 * One qualification question, configured per agent. The core engine turns the list of fields into
 * a runtime validator, the LLM extraction schema and the deterministic fallback prompts.
 */
export const QualificationField = z
  .object({
    key: FieldKey,
    label: z.string().trim().min(1).max(80),
    /** What the agent asks, e.g. "Which service are you looking for?" */
    question: z.string().trim().min(5).max(300),
    type: FieldType,
    options: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
    required: z.boolean().default(true),
    /** ISO 4217 code for currency fields (spoken as lakh/crore for INR) */
    currency: z.string().length(3).default("INR"),
    validation: z
      .object({
        min: z.number().optional(),
        max: z.number().optional(),
        minLength: z.number().int().min(0).optional(),
        maxLength: z.number().int().min(1).max(1000).optional(),
        pattern: z.string().max(200).optional(),
        /** date fields: must be today or later */
        futureOnly: z.boolean().optional(),
      })
      .default({}),
    /** Deterministic re-ask prompts, used in order after a failed or unclear answer */
    reaskPrompts: z.array(z.string().trim().min(5).max(300)).max(3).default([]),
    /** Read the captured value back to the caller ("Got it, 80 lakh.") */
    confirmBack: z.boolean().default(false),
    /** Extra words that help speech recognition, e.g. neighbourhood names */
    hints: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
  })
  .superRefine((f, ctx) => {
    const needsOptions = f.type === "select" || f.type === "multiselect";
    if (needsOptions && f.options.length < 2) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Choice fields need at least 2 options" });
    }
    if (!needsOptions && f.options.length) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Options are only used by choice fields" });
    }
    if (f.validation.pattern) {
      try {
        new RegExp(f.validation.pattern);
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["validation", "pattern"],
          message: "Invalid regular expression",
        });
      }
    }
    const { min, max } = f.validation;
    if (min !== undefined && max !== undefined && min > max) {
      ctx.addIssue({ code: "custom", path: ["validation", "min"], message: "min must not exceed max" });
    }
  });
export type QualificationField = z.infer<typeof QualificationField>;
export type QualificationFieldInput = z.input<typeof QualificationField>;
