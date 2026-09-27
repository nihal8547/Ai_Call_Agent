/** Arabic-Indic (٠-٩) and Persian (۰-۹) digits → 0-9, so numbers read the same in any script */
export function toAsciiDigits(text: string): string {
  return text.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String((d.charCodeAt(0) & 0xf) % 10));
}

/** Lower-case, strip punctuation noise from ASR, collapse whitespace */
export function normalizeUtterance(text: string): string {
  return toAsciiDigits(text)
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

/** Remove filler words and lead-ins such as "um, I'm looking for …" (lower-cased result) */
export function stripFillers(text: string): string {
  return stripFillersKeepCase(normalizeUtterance(text));
}

/** Same as stripFillers but keeps the caller's capitalisation ("MH12 AB", "Baner or Wakad") */
export function stripFillersKeepCase(text: string): string {
  let t = text.replace(/[“”"]/g, "").replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) t = t.replace(FILLERS, "").replace(LEAD_INS, "").trim();
  return t.replace(/[.,!?;:]+$/g, "").trim();
}

const YES =
  /^(?:yes|yeah|yep|yup|ya|sure|ok|okay|correct|right|exactly|absolutely|definitely|of course|please do|go ahead|confirm|confirmed|sounds good|that'?s (?:right|correct|fine|good)|perfect|fine|great|haan|han|ha|ji|theek hai|seri|shari)\b/;
const NO =
  /^(?:no|nope|nah|not really|don'?t|do not|cancel|wait|change|not now|never ?mind|wrong|that'?s wrong|incorrect|nahi|nahin|illa|venda)\b/;

/** Yes/no from a short answer; undefined when neither */
export function parseYesNo(text: string): boolean | undefined {
  const t = stripFillersKeepYesNo(text);
  if (NO.test(t)) return false;
  if (YES.test(t)) return true;
  return undefined;
}

function stripFillersKeepYesNo(text: string): string {
  return normalizeUtterance(text)
    .replace(/^(?:um+|uh+|hmm+|er+|ah+|well|so)[,.\s]+/, "")
    .trim();
}

const WANTS_HUMAN =
  /\b(?:(?:talk|speak|connect|transfer)(?: me)? (?:to|with) (?:a |an |the |some )?(?:human|person|real person|someone|somebody|agent|representative|executive|manager|staff|team|doctor|receptionist)|real person|human being|customer care|a human|operator)\b/;
const NOT_INTERESTED =
  /\b(?:not interested|no longer interested|don'?t call|stop calling|remove my number|wrong number|do not call|leave me alone)\b/;
const QUESTION_START =
  /^(?:what|what's|whats|when|where|which|who|whom|whose|why|how|is there|are there|is it|are you|do you|does|did|can you|can i|could you|could i|will you|would you|should i|may i|tell me)\b/;

export function detectWantsHuman(text: string): boolean {
  return WANTS_HUMAN.test(normalizeUtterance(text));
}
export function detectNotInterested(text: string): boolean {
  return NOT_INTERESTED.test(normalizeUtterance(text));
}
export function detectQuestion(text: string): boolean {
  const t = normalizeUtterance(text);
  return t.endsWith("?") || QUESTION_START.test(stripFillersKeepYesNo(t));
}

export function titleCase(s: string): string {
  return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}
