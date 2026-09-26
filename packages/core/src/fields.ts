import type { QualificationField } from "@platform/shared";
import type { EngineContext } from "./context";
import {
  formatAmount,
  formatDateForSpeech,
  formatTimeForSpeech,
  matchOption,
  matchOptions,
  parseDate,
  parseEmail,
  parseName,
  parseNumber,
  parsePhone,
  parseTime,
  parseYesNo,
  stripFillersKeepCase,
  todayIn,
} from "./normalisers";

export type FieldValue = string | number | boolean | string[];
export type FieldResult = { ok: true; value: FieldValue } | { ok: false; error: string };

const fail = (error: string): FieldResult => ({ ok: false, error });

/**
 * Validate and normalise a raw value for a field. Raw values come either from the LLM's structured
 * output (already typed, or strings) or from deterministic extraction of the caller's words.
 * This is the single gate every value passes before it enters the call state.
 */
export function validateFieldValue(field: QualificationField, raw: unknown, ctx: EngineContext): FieldResult {
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === ""))
    return fail("empty");
  const v = field.validation;
  const asText =
    typeof raw === "string"
      ? raw
      : typeof raw === "number" || typeof raw === "boolean"
        ? String(raw)
        : undefined;

  switch (field.type) {
    case "text":
    case "name": {
      if (asText === undefined) return fail("expected text");
      const value = field.type === "name" ? (parseName(asText) ?? nameFallback(asText)) : cleanText(asText);
      if (!value) return fail("empty");
      if (value.length < (v.minLength ?? 1)) return fail("too short");
      if (value.length > (v.maxLength ?? 200)) return fail("too long");
      if (v.pattern && !new RegExp(v.pattern).test(value)) return fail("does not match the expected format");
      return { ok: true, value };
    }
    case "number":
    case "currency": {
      const n = typeof raw === "number" ? raw : asText !== undefined ? parseNumber(asText) : undefined;
      if (n === undefined || !Number.isFinite(n)) return fail("not a number");
      if (v.min !== undefined && n < v.min) return fail(`must be at least ${v.min}`);
      if (v.max !== undefined && n > v.max) return fail(`must be at most ${v.max}`);
      return { ok: true, value: n };
    }
    case "select": {
      if (asText === undefined) return fail("expected a choice");
      const option = matchOption(asText, field.options);
      return option ? { ok: true, value: option } : fail("not one of the options");
    }
    case "multiselect": {
      const items = Array.isArray(raw) ? raw.map(String) : asText !== undefined ? [asText] : [];
      const matched = [...new Set(items.flatMap((i) => matchOptions(i, field.options)))];
      return matched.length ? { ok: true, value: matched } : fail("not one of the options");
    }
    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      const b = asText !== undefined ? parseYesNo(asText) : undefined;
      return b === undefined ? fail("expected yes or no") : { ok: true, value: b };
    }
    case "date": {
      if (asText === undefined) return fail("expected a date");
      const iso = parseDate(asText, ctx);
      if (!iso) return fail("not a date");
      if (v.futureOnly) {
        const t = todayIn(ctx.timezone, ctx.now);
        const today = `${t.y}-${String(t.m).padStart(2, "0")}-${String(t.d).padStart(2, "0")}`;
        if (iso < today) return fail("must be today or later");
      }
      return { ok: true, value: iso };
    }
    case "time": {
      if (asText === undefined) return fail("expected a time");
      const t = parseTime(asText);
      return t ? { ok: true, value: t } : fail("not a time");
    }
    case "phone": {
      if (asText === undefined) return fail("expected a phone number");
      const p = parsePhone(asText, ctx.defaultCountryCode);
      return p ? { ok: true, value: p } : fail("not a phone number");
    }
    case "email": {
      if (asText === undefined) return fail("expected an email");
      const e = parseEmail(asText);
      return e ? { ok: true, value: e } : fail("not an email address");
    }
  }
}

/** Names must contain letters; anything else is not a name */
function nameFallback(s: string): string {
  const t = cleanText(s);
  return /\p{L}{2,}/u.test(t) ? t : "";
}

/** Free text as spoken, minus fillers and characters that have no place in speech (brackets, markup) */
function cleanText(s: string): string {
  const text = stripFillersKeepCase(s.replace(/[{}[\]<>|\\`*_#~^]/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(text)) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Deterministic extraction of one field from the caller's words — the fallback path when the LLM
 * is unavailable. Returns the raw candidate (validated separately).
 */
export function extractCandidate(field: QualificationField, utterance: string): string | undefined {
  const text = utterance.trim();
  if (!text) return undefined;
  if (field.type === "boolean") return parseYesNo(text) === undefined ? undefined : text;
  if (field.type === "select" || field.type === "multiselect")
    return matchOption(text, field.options) ? text : undefined;
  return text;
}

/** Value as the agent should say it */
export function formatFieldValue(field: QualificationField | undefined, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (!field) return String(value);
  switch (field.type) {
    case "currency":
      return typeof value === "number" ? formatAmount(value, field.currency) : String(value);
    case "number":
      return typeof value === "number" ? value.toLocaleString("en-IN") : String(value);
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? formatDateForSpeech(value)
        : String(value);
    case "time":
      return typeof value === "string" && /^\d{2}:\d{2}$/.test(value)
        ? formatTimeForSpeech(value)
        : String(value);
    case "boolean":
      return value ? "yes" : "no";
    case "multiselect":
      return Array.isArray(value) ? value.join(", ") : String(value);
    default:
      return String(value);
  }
}

type JsonSchema = Record<string, unknown>;

/**
 * JSON schema for the LLM's structured extraction output, generated from the agent's fields.
 * Every field is optional and nullable: the model fills only what the caller actually said.
 */
export function buildExtractionJsonSchema(fields: readonly QualificationField[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const f of fields) {
    const description = `${f.label}. Asked as: "${f.question}"`;
    properties[f.key] = (() => {
      switch (f.type) {
        case "number":
        case "currency":
          return {
            type: ["number", "null"],
            description: `${description}. Plain number${f.type === "currency" ? ` in ${f.currency}, e.g. 80 lakh = 8000000` : ""}.`,
          };
        case "boolean":
          return { type: ["boolean", "null"], description };
        case "select":
          return { type: ["string", "null"], enum: [...f.options, null], description };
        case "multiselect":
          return { type: ["array", "null"], items: { type: "string", enum: f.options }, description };
        case "date":
          return {
            type: ["string", "null"],
            description: `${description}. Exactly as the caller said it, e.g. "next Monday" or "12 October".`,
          };
        case "time":
          return {
            type: ["string", "null"],
            description: `${description}. Exactly as the caller said it, e.g. "5:30 pm".`,
          };
        default:
          return { type: ["string", "null"], description };
      }
    })();
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["intent", "fields"],
    properties: {
      intent: {
        type: "string",
        enum: ["answer", "question", "both", "affirm", "deny", "wants_human", "not_interested", "unclear"],
        description: "What the caller's latest utterance does",
      },
      question: { type: ["string", "null"], description: "The caller's question, if they asked one" },
      fields: { type: "object", additionalProperties: false, properties },
      sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
    },
  };
}
