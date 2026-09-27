import { normalizeUtterance } from "./text";

const SYNONYMS: Record<string, string[]> = {
  apartment: ["flat", "apartment", "2bhk", "3bhk", "1bhk", "bhk"],
  "own funds": ["own funds", "cash", "self funded", "my own money", "savings", "full payment"],
  "bank loan": ["loan", "home loan", "bank", "mortgage", "finance from bank"],
  "need assistance": ["help", "assistance", "not sure", "don't know", "guide"],
  immediately: ["immediately", "right away", "asap", "now", "urgent", "this month"],
  emergency: ["emergency", "urgent", "severe pain", "bleeding", "swelling", "right now"],
  // Dental services, as callers say them
  "general consultation": ["consultation", "checkup", "check up", "general checkup", "examination"],
  "dental cleaning": ["cleaning", "clean my teeth", "scaling", "polishing"],
  "root canal": ["root canal", "rct", "nerve treatment"],
  "dental implants": ["implant", "implants"],
  "teeth whitening": ["whitening", "whiten", "bleaching"],
  braces: ["braces", "aligners", "invisalign", "orthodontic"],
  // Asked "an emergency, within a week, or flexible?", callers often just name a day
  "within a week": [
    ...["within a week", "this week", "next week", "tomorrow", "today", "day after tomorrow"],
    ...["in a few days", "few days", "couple of days", "soon", "sunday", "monday", "tuesday"],
    ...["wednesday", "thursday", "friday", "saturday"],
  ],
  flexible: ["flexible", "any time", "anytime", "whenever", "no rush"],
  "just exploring": ["exploring", "just looking", "browsing", "not sure yet", "no plan"],
  none: ["none", "no occasion", "nothing special", "no"],
  // Arabic options, keyed by their folded spelling (see fold below), and how Gulf callers say them
  شقه: ["شقه", "شقق", "ابارتمنت", "apartment", "flat"],
  فيلا: ["فيلا", "فله", "فلل", "villa"],
  "تاون هاوس": ["تاون هاوس", "تاونهاوس", "townhouse"],
  تجاري: ["تجاري", "محل", "مكتب", "commercial"],
  كاش: ["كاش", "نقدا", "نقد", "من جيبي", "cash"],
  "تمويل بنكي": ["تمويل", "قرض", "بنك", "loan", "mortgage"],
  "احتاج مساعده": ["مساعده", "ساعدوني", "مو متاكد", "ما ادري", "ما اعرف"],
  فورا: ["فورا", "الحين", "على طول", "هالشهر", "بسرعه", "مستعجل"],
  "خلال 3 شهور": ["3 شهور", "ثلاث شهور", "ثلاثه شهور", "three months"],
  "من 3 الي 6 شهور": ["6 شهور", "سته شهور", "ست شهور", "نص سنه"],
  "استكشف فقط": ["استكشف", "اتفرج", "بس اشوف", "اشوف بس", "مجرد استفسار", "مو الحين"],
  طواري: ["طواري", "طارئ", "طارئه", "طاريه", "الم شديد", "نزيف", "ورم", "انتفاخ", "emergency"],
  "خلال اسبوع": [
    ...["اسبوع", "هالاسبوع", "الاسبوع هذا", "الاسبوع الجاي", "بكره", "باكر", "بكرا", "اليوم", "بعد بكره"],
    ...["كم يوم", "يومين", "قريب", "الاحد", "الاثنين", "الثلاثاء", "الاربعاء", "الخميس", "السبت"],
  ],
  مرن: ["مرن", "اي وقت", "مو مستعجل", "على راحتي", "على راحتكم", "flexible"],
  "استشاره عامه": ["استشاره", "كشف", "فحص", "checkup"],
  "تنظيف اسنان": ["تنظيف", "تلميع", "cleaning"],
  "علاج عصب": ["عصب", "سحب عصب", "root canal"],
  "زراعه اسنان": ["زراعه", "implant"],
  "تبييض اسنان": ["تبييض", "تبيض", "whitening"],
  "تقويم اسنان": ["تقويم", "braces"],
};

/** Lower-case, folded Arabic, letters and digits only: how options and speech are compared */
const fold = (s: string) =>
  normalizeUtterance(s)
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/(^|\s)ال(?=\p{L}{2,})/gu, "$1")
    .replace(/\s+/g, " ")
    .trim();

/** The caller said this option by name (whole words; "the" / ال is ignored) */
export function mentionsOption(input: string, option: string): boolean {
  const o = fold(option);
  return o.length > 0 && ` ${fold(input)} `.includes(` ${o} `);
}

/**
 * Match free speech to one configured option: exact/contains match first, then synonyms,
 * then word overlap. Returns the option exactly as configured.
 */
export function matchOption(input: string, options: readonly string[]): string | undefined {
  const text = ` ${fold(input)} `;
  const norm = fold;

  // 1. an option mentioned verbatim (longest first, so "3 to 6 months" beats "months")
  const byLength = [...options].sort((a, b) => norm(b).length - norm(a).length);
  const exact = byLength.find((o) => text.includes(` ${norm(o)} `));
  if (exact) return exact;

  // 2. synonyms
  // the longest synonym heard wins: "بس اشوف الحين" is "just looking", though "الحين" alone is "now"
  let bySynonym: { option: string; length: number } | undefined;
  for (const o of options) {
    for (const syn of SYNONYMS[norm(o)] ?? []) {
      const f = fold(syn);
      if (text.includes(` ${f} `) && f.length > (bySynonym?.length ?? 0))
        bySynonym = { option: o, length: f.length };
    }
  }
  if (bySynonym) return bySynonym.option;

  // 3. best word overlap (ignoring tiny words)
  const words = new Set(
    text
      .trim()
      .split(" ")
      .filter((w) => w.length > 2),
  );
  let best: { option: string; score: number } | undefined;
  for (const o of options) {
    const ow = norm(o)
      .split(" ")
      .filter((w) => w.length > 2);
    if (!ow.length) continue;
    const hits = ow.filter(
      (w) => words.has(w) || [...words].some((x) => x.startsWith(w) || w.startsWith(x)),
    ).length;
    const score = hits / ow.length;
    if (score > 0 && (!best || score > best.score)) best = { option: o, score };
  }
  return best && best.score >= 0.5 ? best.option : undefined;
}

/**
 * An option the caller named outright, or by a known synonym (no loose word overlap): safe for
 * picking up answers to questions that weren't asked yet ("a villa, cash, within 3 months").
 */
export function recogniseOption(input: string, options: readonly string[]): string | undefined {
  if (options.some((o) => mentionsOption(input, o))) return matchOption(input, options);
  const text = ` ${fold(input)} `;
  let best: { option: string; length: number } | undefined;
  for (const o of options)
    for (const syn of SYNONYMS[fold(o)] ?? []) {
      const f = fold(syn);
      if (text.includes(` ${f} `) && f.length > (best?.length ?? 0)) best = { option: o, length: f.length };
    }
  return best?.option;
}

export function matchOptions(input: string, options: readonly string[]): string[] {
  return options.filter((o) => mentionsOption(input, o) || matchOption(input, [o]) === o);
}
