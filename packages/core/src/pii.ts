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

export function redactPII(text: string): string {
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
