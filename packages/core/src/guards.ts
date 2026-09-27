import { toAsciiDigits } from "./normalisers/text";
export type GuardResult = { ok: true; text: string } | { ok: false; violations: string[] };

const BLOCKED: [string, RegExp][] = [
  [
    "technical_error",
    /\b(error|exception|stack ?trace|traceback|undefined|null|nan|internal server|status code|timeout|timed out|api key|prompt|json|schema|llm|language model)\b/i,
  ],
  ["markup", /[{}<>[\]|\\]|```|^\s*#|\*\*|__/m],
  ["secret", /(sk-[a-z0-9]{10,}|AKIA[0-9A-Z]{16}|vk_[a-z0-9_-]{8,}|-----BEGIN|eyJ[a-z0-9_-]{10,}\.)/i],
  ["url", /\bhttps?:\/\/|www\.[a-z]/i],
];

/**
 * Last check before text reaches text-to-speech. Rejects anything that sounds like a system error,
 * markup, secrets or URLs, and trims overlong replies at a sentence boundary.
 * When it fails, the runtime speaks the deterministic fallback instead.
 */
export function guardOutput(text: string, opts: { maxChars?: number } = {}): GuardResult {
  const maxChars = opts.maxChars ?? 450;
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return { ok: false, violations: ["empty"] };
  const violations = BLOCKED.filter(([, re]) => re.test(cleaned)).map(([name]) => name);
  if (violations.length) return { ok: false, violations };
  if (cleaned.length <= maxChars) return { ok: true, text: cleaned };
  const cut = cleaned.slice(0, maxChars);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return end > maxChars * 0.5
    ? { ok: true, text: cut.slice(0, end + 1) }
    : { ok: false, violations: ["too_long"] };
}

/**
 * Grounding check for knowledge answers: every number in the answer (prices, dates, counts)
 * must appear in the retrieved sources or the caller's own details. Catches invented figures.
 */
export function unsupportedNumbers(answer: string, sources: readonly string[]): string[] {
  const norm = (s: string) => toAsciiDigits(s).replace(/(\d)[,٬](?=\d)/g, "$1");
  const haystack = norm(sources.join(" "));
  const numbers = norm(answer).match(/\d+(?:\.\d+)?/g) ?? [];
  return [...new Set(numbers)].filter(
    (n) => !new RegExp(`(^|[^\\d.])${n.replace(".", "\\.")}([^\\d]|$)`).test(haystack),
  );
}
