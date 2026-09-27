import { normalizeUtterance, titleCase } from "./text";

/**
 * Digits in a national number (without the trunk "0"), by country calling code. Countries not
 * listed accept 7–12 digits. India 10, Gulf states 8–9, North America 10, UK 10.
 */
export const NATIONAL_NUMBER_LENGTH: Record<string, number[]> = {
  "91": [10],
  "974": [8], // Qatar: 3/5/6/7… mobiles, 4… landlines
  "971": [8, 9], // UAE
  "966": [9], // Saudi Arabia
  "965": [8], // Kuwait
  "968": [8], // Oman
  "973": [8], // Bahrain
  "1": [10],
  "44": [10],
};

/** Spoken or typed phone number → E.164 using the business's default country code */
export function parsePhone(input: string, defaultCountryCode = "91"): string | undefined {
  const text = normalizeUtterance(input)
    .replace(/\bzero\b|\boh\b/g, "0")
    .replace(/\bone\b/g, "1")
    .replace(/\btwo\b/g, "2")
    .replace(/\bthree\b/g, "3")
    .replace(/\bfour\b/g, "4")
    .replace(/\bfive\b/g, "5")
    .replace(/\bsix\b/g, "6")
    .replace(/\bseven\b/g, "7")
    .replace(/\beight\b/g, "8")
    .replace(/\bnine\b/g, "9")
    .replace(/\bdouble (\d)/g, "$1$1")
    .replace(/\btriple (\d)/g, "$1$1$1");
  const trimmed = text.trim();
  let digits = text.replace(/\D/g, "");
  // "+974 …" or the international prefix "00974 …"
  if (trimmed.startsWith("+") || (digits.startsWith("00") && digits.length >= 10)) {
    if (!trimmed.startsWith("+")) digits = digits.slice(2);
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : undefined;
  }
  const national = NATIONAL_NUMBER_LENGTH[defaultCountryCode] ?? [7, 8, 9, 10, 11, 12];
  if (national.includes(digits.length)) return `+${defaultCountryCode}${digits}`;
  if (digits.startsWith("0") && national.includes(digits.length - 1))
    return `+${defaultCountryCode}${digits.slice(1)}`;
  if (digits.startsWith(defaultCountryCode) && national.includes(digits.length - defaultCountryCode.length))
    return `+${digits}`;
  return undefined;
}

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

/** "john dot doe at gmail dot com" → "john.doe@gmail.com" */
export function parseEmail(input: string): string | undefined {
  const text = normalizeUtterance(input)
    .replace(/^(?:my email is|email is|it's|it is)\s+/, "")
    .replace(/\s+(?:at the rate|at the rate of|at)\s+/g, "@")
    .replace(/\s+(?:dot|period)\s+/g, ".")
    .replace(/\s+underscore\s+/g, "_")
    .replace(/\s+(?:dash|hyphen)\s+/g, "-")
    .replace(/\s+/g, "");
  return EMAIL.test(text) ? text : undefined;
}

const NAME_PATTERNS = [
  /\b(?:my name is|my name's|name is|this is|i am|i'm|it's|it is|call me|speaking,?|you can call me|the name is|the patient is|patient name is|booking for|for)\s+([a-z][a-z .'-]{0,60})$/,
];

/** "Hi, my name is Rahul Sharma" → "Rahul Sharma" */
export function parseName(input: string): string | undefined {
  const text = normalizeUtterance(input)
    .replace(/[.,!?]+$/g, "")
    .replace(/\s+(?:here|speaking)$/g, "");
  for (const re of NAME_PATTERNS) {
    const m = text.match(re);
    if (m) return clean(m[1]!);
  }
  const words = text
    .replace(/^(?:hi|hello|hey|yes|yeah|ok|okay|sure|um+|uh+)[, ]+/g, "")
    .split(" ")
    .filter(Boolean);
  if (words.length >= 1 && words.length <= 4 && words.every((w) => /^[a-z][a-z.'-]*$/.test(w)))
    return clean(words.join(" "));
  return undefined;
}

function clean(name: string): string | undefined {
  const n = name
    .replace(/\b(?:and|please|sir|madam|ma'am)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return n.length >= 2 ? titleCase(n) : undefined;
}
