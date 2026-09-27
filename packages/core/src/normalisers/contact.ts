import { arabicNumberWords, foldArabic, hasArabic } from "./arabic";
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
  // Arabic digits by name ("خمسة خمسة واحد …") become English words, then digits
  const text = arabicNumberWords(normalizeUtterance(input))
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

const AR_NAME_LEAD = /(?:^|\s)(?:اسمي|إسمي|أسمي|الاسم|انا|أنا|معك|معاك|معكم|وياك|هنا)\s+(.+)$/;
/** After "أنا …" these start a sentence, not a name ("أنا أبي شقة" = "I want a flat") */
const AR_NOT_NAME = /^(?:[اأ]بي|[اأ]بغ[ىيا]|[اأ]ريد|ودي|مهتم|[اأ]تصل|[اأ]سأل|ساكن|من|في|عندي|محتاج)(?:\s|$)/;
const AR_POLITE = /\s+(?:لو سمحت|من فضلك|تفضل|يا [اأ]خي|يا [اأ]ختي)$/;
const AR_GREETING =
  /^(?:مرحبا|مرحبتين|هلا(?: والله)?|اهلا|السلام عليكم|سلام عليكم|صباح الخير|مساء الخير|الو)\s+/;
/** Words that make a sentence, never a name (checked after folding hamza, ى and ة) */
const AR_SENTENCE_WORDS = new Set([
  ...["ابي", "ابغي", "ابغا", "اريد", "ودي", "محتاج", "احتاج", "عندي", "ممكن", "موعد", "حجز", "احجز"],
  ...["كم", "متي", "وين", "شو", "ايش", "ليش", "هل", "نعم", "لا", "ايوه", "بكره", "باكر", "اليوم"],
]);
/** English words that make a request or a question, never a name ("Hi, I need a cleaning") */
const SENTENCE_WORDS = new Set([
  ...["i", "me", "my", "we", "our", "you", "your", "a", "an", "the", "to", "of", "in", "on", "at"],
  ...["is", "are", "am", "was", "be", "do", "does", "can", "could", "would", "will", "should", "have"],
  ...["has", "need", "needs", "want", "wanted", "like", "looking", "book", "booking", "appointment"],
  ...["help", "call", "calling", "about", "what", "when", "where", "why", "how", "which", "who"],
  ...["yes", "no", "not", "please", "thanks", "thank", "it", "this", "that", "there", "some", "any"],
  ...["today", "tomorrow", "morning", "evening", "afternoon", "tonight", "week", "time", "with"],
  ...["fine", "ok", "okay", "sure", "good", "great", "right", "correct", "don", "can", "won", "isn"],
]);

/** "اسمي فاطمة الكواري" → "فاطمة الكواري" (spelling kept as heard) */
function parseArabicName(input: string): string | undefined {
  const text = input
    .replace(/[.,!?،؟]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(AR_POLITE, "");
  const m = text.match(AR_NAME_LEAD);
  const candidate = (m ? m[1]! : text.replace(AR_GREETING, "")).trim();
  if (AR_NOT_NAME.test(candidate)) return undefined;
  const words = candidate.split(" ").filter(Boolean);
  if (words.some((w) => AR_SENTENCE_WORDS.has(foldArabic(w).replace(/^و(?=\S{3,})/, "")))) return undefined;
  const ok = words.length >= 1 && words.length <= 4 && words.every((w) => /^[\p{L}\u064B-\u0652]+$/u.test(w));
  return ok && candidate.length >= 2 ? candidate : undefined;
}

/** "Hi, my name is Rahul Sharma" → "Rahul Sharma"; "اسمي فاطمة" → "فاطمة" */
export function parseName(input: string): string | undefined {
  if (hasArabic(input)) return parseArabicName(input);
  const text = normalizeUtterance(input)
    .replace(/[.,!?]+$/g, "")
    .replace(/\s+(?:here|speaking)$/g, "");
  for (const re of NAME_PATTERNS) {
    const m = text.match(re);
    if (m) return looksLikeName(m[1]!) ? clean(m[1]!) : undefined;
  }
  const words = text
    .replace(/^(?:(?:hi|hello|hey|yes|yeah|ok|okay|sure|um+|uh+)[, ]+)+/g, "")
    .split(" ")
    .filter(Boolean);
  if (
    words.length >= 1 &&
    words.length <= 4 &&
    words.every((w) => /^[a-z][a-z.'-]*$/.test(w)) &&
    looksLikeName(words.join(" "))
  )
    return clean(words.join(" "));
  return undefined;
}

/** "rahul sharma" yes; "i need a cleaning", "for tomorrow" no */
function looksLikeName(candidate: string): boolean {
  return !candidate
    .trim()
    .split(/\s+/)
    .some((w) => SENTENCE_WORDS.has(w.replace(/'(?:s|re|m|ll|d|ve|t)$/, "").replace(/[.,'-]+$/g, "")));
}

function clean(name: string): string | undefined {
  const n = name
    .replace(/\b(?:and|please|sir|madam|ma'am)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return n.length >= 2 ? titleCase(n) : undefined;
}
