import { guardOutput, unsupportedNumbers } from "@platform/core";

/**
 * Accept an LLM rephrasing only if it is safe to say and keeps the draft's meaning:
 * same numbers (no new ones, none dropped), still asks the question, no runaway length.
 */
export function checkPhrase(
  draft: string,
  reply: string,
): { ok: true; text: string } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const guarded = guardOutput(reply);
  if (!guarded.ok) reasons.push(...guarded.violations.map((v) => `guard:${v}`));
  if (unsupportedNumbers(reply, [draft]).length) reasons.push("added_numbers");
  if (unsupportedNumbers(draft, [reply]).length) reasons.push("dropped_numbers");
  if (draft.includes("?") && !reply.includes("?")) reasons.push("dropped_question");
  if (reply.length > draft.length * 1.6 + 80) reasons.push("too_long");
  return reasons.length || !guarded.ok ? { ok: false, reasons } : { ok: true, text: guarded.text };
}
