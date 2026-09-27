import { foldArabic } from "./arabic";

/** Arabic-Indic (٠-٩) and Persian (۰-۹) digits → 0-9, so numbers read the same in any script */
export function toAsciiDigits(text: string): string {
  return text.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String((d.charCodeAt(0) & 0xf) % 10));
}

/** Lower-case, fold Arabic spellings, strip punctuation noise from ASR, collapse whitespace */
export function normalizeUtterance(text: string): string {
  return foldArabic(toAsciiDigits(text))
    .toLowerCase()
    .replace(/[“”"]/g, "")
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const FILLERS =
  /^(?:(?:um+|uh+|hmm+|er+|ah+|okay|ok|so|well|yeah|yes|actually|basically|like|see|i think|i guess|maybe|probably|around|about|roughly)[,.\s]+)+/i;
const LEAD_INS =
  /^(?:(?:it'?s|it is|that'?s|that is|i'?m looking for|i am looking for|looking for|i want|i would like|i'?d like|we want|we need|i need|we'?re looking for|we are looking for|preferably|prefer|in|at|on|for)\s+)+/i;

// Arabic (Gulf and standard) fillers and lead-ins: "يعني", "أبي", "أبغى", "تقريباً" … (any alef, with or without ى)
const AR_FILLERS =
  /^(?:(?:يعني|طيب|ام+|اه+|والله|بصراحه|بصراحة|تقريبا|تقريباً|حوالي|حوالى|في حدود|السلام عليكم|مرحبا|هلا|اهلا|أهلا)[،,.\s]+)+/;
const AR_LEAD_INS =
  /^(?:(?:[اأ]بي|[اأ]بغ[يىا]|[اأ]ريد|ودي|[اأ]حتاج|نبي|نبغ[يىا]|نريد|[اأ]دور على|ندور على|[اأ]فضل)\s+)+/;

/** Remove filler words and lead-ins such as "um, I'm looking for …" (lower-cased result) */
export function stripFillers(text: string): string {
  return stripFillersKeepCase(normalizeUtterance(text));
}

/** Same as stripFillers but keeps the caller's capitalisation ("MH12 AB", "Baner or Wakad") */
export function stripFillersKeepCase(text: string): string {
  let t = text.replace(/[“”"]/g, "").replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++)
    t = t.replace(FILLERS, "").replace(LEAD_INS, "").replace(AR_FILLERS, "").replace(AR_LEAD_INS, "").trim();
  return t.replace(/[.,!?;:،؟]+$/g, "").trim();
}

const YES =
  /^(?:yes|yeah|yep|yup|ya|sure|ok|okay|correct|right|exactly|absolutely|definitely|of course|please do|go ahead|confirm|confirmed|sounds good|that'?s (?:right|correct|fine|good)|perfect|fine|great|haan|han|ha|ji|theek hai|seri|shari)\b/;
const NO =
  /^(?:no|nope|nah|not really|don'?t|do not|cancel|wait|change|not now|never ?mind|wrong|that'?s wrong|incorrect|nahi|nahin|illa|venda)\b/;

// Arabic, on folded text (ا for أ/إ, ي for ى, ه for ة). "لا بأس" (no problem) is a yes.
const AR_END = "(?=$|[\\s,.!?])";
const YES_AR = new RegExp(
  `^(?:نعم|ايوه|ايوا|ايه|اي(?=$|[,.!]|\\s+(?:نعم|والله|اكيد|تمام|صح|اكد|اوكي|طيب|ماشي|زين))|اكيد|تمام|صح|صحيح|مضبوط|زين|اوكي|اوك|طيب|بالضبط|يب|موافق|ماشي|لا باس|ان شاء الله|انشاءالله|انشالله|اكد|اكدي|يعطيك العافيه)${AR_END}`,
);
const NO_AR = new RegExp(
  `^(?:لا|لاء|لاا|مو|مب|موب|ابد|ابدا|غلط|خطا|الغ|الغي|الغاء|كنسل|لحظه|غير|ما ابي|ما ابغي|مابي|مابغي|ما اريد|مو صحيح|مو صح)${AR_END}`,
);

/** Yes/no from a short answer (English or Arabic); undefined when neither */
export function parseYesNo(text: string): boolean | undefined {
  const t = stripFillersKeepYesNo(text);
  if (YES_AR.test(t) && /^لا باس/.test(t)) return true;
  if (NO.test(t) || NO_AR.test(t)) return false;
  if (YES.test(t) || YES_AR.test(t)) return true;
  return undefined;
}

function stripFillersKeepYesNo(text: string): string {
  return normalizeUtterance(text)
    .replace(/^(?:um+|uh+|hmm+|er+|ah+|well|so)[,.\s]+/, "")
    .replace(/^(?:يعني|طيب(?=[,\s]+\S)|ام+|اه+|السلام عليكم|مرحبا|هلا|اهلا|لو سمحت|من فضلك)[,.\s]+/, "")
    .trim();
}

const WANTS_HUMAN =
  /\b(?:(?:talk|speak|connect|transfer)(?: me)? (?:to|with) (?:a |an |the |some )?(?:human|person|real person|someone|somebody|agent|representative|executive|manager|staff|team|doctor|receptionist)|real person|human being|customer care|a human|operator)\b/;
const NOT_INTERESTED =
  /\b(?:not interested|no longer interested|don'?t call|stop calling|remove my number|wrong number|do not call|leave me alone)\b/;
const QUESTION_START =
  /^(?:what|what's|whats|when|where|which|who|whom|whose|why|how|is there|are there|is it|are you|do you|does|did|can you|can i|could you|could i|will you|would you|should i|may i|tell me)\b/;

const PERSON_AR =
  "(?:موظف|موظفه|شخص|احد|انسان|بشر|المدير|مدير|المسؤول|الاستقبال|خدمه العملاء|الدكتور|دكتور|الدكتوره)";
const WANTS_HUMAN_AR = new RegExp(
  [
    `(?:ابي|ابغي|ابغا|ابا|اريد|ودي|ممكن|خلني|نبي|نبغي)\\s+(?:اكلم|اتكلم|احاكي|احكي|اتواصل|نكلم|نتكلم)(?:\\s+(?:مع|وياه|ويا))?\\s+${PERSON_AR}`,
    `(?:حولني|وصلني|كلمني|حولوني|وصلوني)(?:\\s+(?:ل|على|مع|الى|علي))?\\s*${PERSON_AR}`,
    "(?:انسان|شخص|موظف) حقيقي",
    "خدمه العملاء",
  ].join("|"),
);
const NOT_INTERESTED_AR =
  /(?:(?:مو|مب|غير|مانيب|ماني|لست)\s*مهتم|ما\s*(?:ابي|ابغي|اريد)\s*(?:شي|شيء|شي ابد)|لا\s*(?:تتصل|تتصلون|تكلمني|تتصلوا)|(?:الرقم|رقم|اتصال)\s*غلط|ما يهمني)/;
const QUESTION_START_AR = new RegExp(
  `^(?:كم|بكم|متي|وين|فين|اين|هل|شو|ايش|وش|شنو|اش|ليش|لماذا|ليه|كيف|شلون|منو|مين|من هو|عندكم|عندك|فيه|في عندكم|ممكن اعرف|ابي اعرف|ابغي اعرف|اريد اعرف|تقدر تقول|تقدرون|ودي اعرف)${AR_END}`,
);

export function detectWantsHuman(text: string): boolean {
  const t = normalizeUtterance(text);
  return WANTS_HUMAN.test(t) || WANTS_HUMAN_AR.test(t);
}
export function detectNotInterested(text: string): boolean {
  const t = normalizeUtterance(text);
  return NOT_INTERESTED.test(t) || NOT_INTERESTED_AR.test(t);
}
export function detectQuestion(text: string): boolean {
  const t = normalizeUtterance(text);
  const lead = stripFillersKeepYesNo(t);
  return t.endsWith("?") || QUESTION_START.test(lead) || QUESTION_START_AR.test(lead);
}

export function titleCase(s: string): string {
  return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}
