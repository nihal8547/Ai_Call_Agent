/**
 * Redact personal data before transcripts and events are logged or stored.
 * Order matters: longer, more specific patterns first.
 */
const RULES: [string, RegExp][] = [
  ["[EMAIL]", /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi],
  ["[PAN]", /\b[A-Z]{5}\d{4}[A-Z]\b/g],
  ["[AADHAAR]", /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g],
  ["[PHONE]", /(?:\+?\d{1,3}[ -]?)?(?:\(?\d{2,5}\)?[ -]?)?\d{3,5}[ -]?\d{4,5}\b/g],
];

const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Identifiers and timestamps are not personal data, but their digit runs look like phone numbers
 * (a UUID starting "74838446-7c35…" would otherwise become "[PHONE]-7c35…"). They are kept verbatim.
 */
const KEEP =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/gi;

export function redactPII(text: string): string {
  const kept: string[] = [];
  const masked = text.replace(KEEP, (m) => `\uE000${kept.push(m) - 1}\uE000`);
  return redactText(masked).replace(/\uE000(\d+)\uE000/g, (m: string, i: string) => kept[Number(i)] ?? m);
}

function redactText(text: string): string {
  let out = text.replace(CARD, (m) => {
    const digits = m.replace(/\D/g, "");
    return digits.length >= 13 && luhn(digits) ? "[CARD]" : m;
  });
  for (const [label, re] of RULES) {
    out = out.replace(re, (m) => (m.replace(/\D/g, "").length >= 7 || label !== "[PHONE]" ? label : m));
  }
  return out;
}

/** Redact every string inside a JSON-like value (event payloads) */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactPII(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  }
  return value;
}
