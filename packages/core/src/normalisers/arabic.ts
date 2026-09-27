/**
 * Arabic support for the deterministic understanding path. Callers in the Gulf mix Gulf Arabic,
 * Modern Standard Arabic and English, and speech recognition spells the same word several ways
 * (أ/إ/آ/ا, ة/ه, ى/ي, with or without diacritics). Matching runs on folded text; number, date and
 * time words are translated to the English words the existing parsers already understand.
 */

const ARABIC = /[؀-ۿ]/;
/** Right side of an Arabic word: JavaScript's \b only knows ASCII word characters */
const END = "(?=$|[\\s,.!?:;])";
const START = "(^|\\s)";

export const hasArabic = (text: string): boolean => ARABIC.test(text);

/** Language code → does the agent speak Arabic? ("ar", "ar-QA", "ar-AE" …) */
export const isArabic = (language: string | undefined): boolean => /^ar(?:-|$)/i.test(language ?? "");

/** One spelling for matching: no diacritics or tatweel, one alef, ى→ي, ة→ه, Arabic punctuation → ASCII */
export function foldArabic(text: string): string {
  return text
    .replace(/[ً-ْٰـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/؟/g, "?")
    .replace(/،/g, ",")
    .replace(/؛/g, ";");
}

/** Replace whole Arabic words (optionally after the conjunction و "and") */
function words(text: string, table: [string, string][], allowAnd = false): string {
  let t = text;
  for (const [ar, en] of table) {
    const re = new RegExp(`${START}${allowAnd ? "(و)?" : "()"}(?:${ar})${END}`, "g");
    t = t.replace(re, (_, pre: string, and: string | undefined) => `${pre}${and ? "and " : ""}${en}`);
  }
  return t;
}

// Longest forms first: ثلاثين before ثلاث, عشرين before عشر
const TEENS: [string, string][] = [
  ["(?:ثلاث|ثلاثه|ثلطا?|تلت)\\s?(?:عشر|طعش|تعش|تاش)", "thirteen"],
  ["(?:اربع|اربعه|اربعت|ارب)\\s?(?:عشر|طعش|تعش|تاش)", "fourteen"],
  ["(?:خمس|خمسه|خمست|خمص)\\s?(?:عشر|طعش|تعش|تاش)", "fifteen"],
  ["(?:ست|سته|سيت|سط)\\s?(?:عشر|طعش|تعش|تاش)", "sixteen"],
  ["(?:سبع|سبعه|سبعت|سبط)\\s?(?:عشر|طعش|تعش|تاش)", "seventeen"],
  ["(?:ثمان|ثماني|ثمانيه|ثمنت|تمن)\\s?(?:عشر|طعش|تعش|تاش)", "eighteen"],
  ["(?:تسع|تسعه|تسعت|تسط)\\s?(?:عشر|طعش|تعش|تاش)", "nineteen"],
  ["(?:احد عشر|احدي عشر|احدعش|حداش|احداش|حدعش)", "eleven"],
  ["(?:اثنا عشر|اثني عشر|اثنعش|اثناش|ثنعش|طنعش|اطنعش)", "twelve"],
];
const TENS: [string, string][] = [
  ["عشرين", "twenty"],
  ["ثلاثين|تلاتين", "thirty"],
  ["اربعين", "forty"],
  ["خمسين", "fifty"],
  ["ستين", "sixty"],
  ["سبعين", "seventy"],
  ["ثمانين|تمانين", "eighty"],
  ["تسعين", "ninety"],
];
const HUNDREDS: [string, string][] = [
  ["(?:ثلاث|ثلاثه)\\s?(?:ميه|مئه|مايه)", "three hundred"],
  ["(?:اربع|اربعه)\\s?(?:ميه|مئه|مايه)", "four hundred"],
  ["(?:خمس|خمسه)\\s?(?:ميه|مئه|مايه)", "five hundred"],
  ["(?:ست|سته)\\s?(?:ميه|مئه|مايه)", "six hundred"],
  ["(?:سبع|سبعه)\\s?(?:ميه|مئه|مايه)", "seven hundred"],
  ["(?:ثمان|ثماني|ثمانيه)\\s?(?:ميه|مئه|مايه)", "eight hundred"],
  ["(?:تسع|تسعه)\\s?(?:ميه|مئه|مايه)", "nine hundred"],
  ["ميتين|مئتين|مائتين|مايتين|ميتان", "two hundred"],
  ["ميه|مئه|مايه", "one hundred"],
];
const UNITS: [string, string][] = [
  ["صفر", "zero"],
  ["واحد|واحده|وحده", "one"],
  ["اثنين|اثنان|اثنتين|ثنين|ثنتين|اتنين", "two"],
  ["ثلاثه|ثلاث|تلاته|تلات", "three"],
  ["اربعه|اربع", "four"],
  ["خمسه|خمس", "five"],
  ["سته|ست", "six"],
  ["سبعه|سبع", "seven"],
  ["ثمانيه|ثماني|ثمان|تمانيه", "eight"],
  ["تسعه|تسع", "nine"],
  ["عشره|عشر", "ten"],
];
const LARGE: [string, string][] = [
  ["الفين|الفان", "two thousand"],
  ["الف|الاف|الوف", "thousand"],
  ["مليونين", "two million"],
  ["مليون|ملايين", "million"],
  ["مليار|مليارات", "billion"],
  ["نص|نصف", "half"],
];

/** "مية وخمسين ألف" → "one hundred and fifty thousand" (other words left as they are) */
export function arabicNumberWords(folded: string): string {
  let t = words(folded, HUNDREDS, true);
  t = words(t, TEENS, true);
  t = words(t, TENS, true);
  t = words(t, LARGE, true);
  return words(t, UNITS, true);
}

const WEEKDAYS: [string, string][] = [
  ["(?:يوم\\s)?(?:الاحد|هالاحد)", "sunday"],
  ["(?:يوم\\s)?(?:الاثنين|الاتنين|الثنين|هالاثنين)", "monday"],
  ["(?:يوم\\s)?(?:الثلاثاء|الثلاثا|الثلوث|هالثلاثاء)", "tuesday"],
  ["(?:يوم\\s)?(?:الاربعاء|الاربعا|الربوع|هالاربعاء)", "wednesday"],
  ["(?:يوم\\s)?(?:الخميس|هالخميس)", "thursday"],
  ["(?:يوم\\s)?(?:الجمعه|هالجمعه)", "friday"],
  ["(?:يوم\\s)?(?:السبت|هالسبت)", "saturday"],
];
const MONTHS: [string, string][] = [
  ["يناير", "january"],
  ["فبراير", "february"],
  ["مارس", "march"],
  ["ابريل", "april"],
  ["مايو", "may"],
  ["يونيو", "june"],
  ["يوليو", "july"],
  ["اغسطس", "august"],
  ["سبتمبر", "september"],
  ["اكتوبر", "october"],
  ["نوفمبر", "november"],
  ["ديسمبر", "december"],
];

/** "بعد بكرة", "الأحد الجاي", "15 أكتوبر", "بعد ثلاث أيام" → English date words */
export function arabicDateWords(text: string): string {
  let t = foldArabic(text.toLowerCase());
  if (!hasArabic(t)) return text;
  t = words(t, [
    ["بعد بكره|بعد بكرا|بعد باكر|بعد غدا|بعد الغد", "day after tomorrow"],
    ["بكره|بكرا|باكر|غدا|الغد", "tomorrow"],
    ["اليوم|الحين|الليله|هاليوم", "today"],
    ["الاسبوع الجاي|الاسبوع الياي|الاسبوع القادم|الاسبوع اللي جاي", "next week"],
    ["يومين", "two days"],
  ]);
  t = words(t, WEEKDAYS);
  t = words(t, MONTHS);
  t = arabicNumberWords(t);
  // "بعد three ايام" → "in three days"
  t = t.replace(/(^|\s)بعد\s+(\S+(?:\s\S+)?)\s+(?:ايام|يوم)(?=$|\s)/g, "$1in $2 days");
  t = t.replace(/(^|\s)بعد\s+two days/g, "$1in two days");
  return t.replace(/(^|\s)(?:الجاي|الياي|القادم|اللي جاي|الجايه)(?=$|\s)/g, "$1");
}

/** "الساعة خمس ونص العصر", "عشرة الصبح", "٥ م" → "at five thirty afternoon", "ten morning", "5 pm" */
export function arabicTimeWords(text: string): string {
  let t = foldArabic(text.toLowerCase());
  if (!hasArabic(t)) return text;
  t = t
    .replace(/(\d)\s*م(?=$|\s)/g, "$1 pm")
    .replace(/(\d)\s*ص(?=$|\s)/g, "$1 am")
    .replace(/(^|\s)(\S+)\s+الا\s+ربع(?=$|\s)/g, "$1quarter to $2")
    .replace(/\s*و\s?نص(?=$|\s)/g, " thirty")
    .replace(/\s*و\s?ربع(?=$|\s)/g, " fifteen");
  t = words(t, [
    ["الساعه|ساعه", "at"],
    ["الصبح|الصباح|صباحا|صباح|الفجر", "morning"],
    ["الظهر|الضهر|ظهرا", "pm noon"],
    ["العصر|عصرا|بعد الظهر", "afternoon"],
    ["المغرب|المسا|المساء|مساء|مسا", "evening"],
    ["بالليل|الليل|ليلا|الليله", "night"],
  ]);
  return arabicNumberWords(t);
}

/** Money words to drop before reading an amount */
export const ARABIC_CURRENCY = /(^|\s)(?:ريال|ريالات|درهم|دراهم|دينار|دنانير|دولار|روبيه|ق\.?ر)(?=$|\s)/g;

// ── Speaking ──────────────────────────────────────────────────────────────────

const CURRENCY_AR: Record<string, string> = {
  QAR: "ريال",
  SAR: "ريال",
  OMR: "ريال عماني",
  AED: "درهم",
  KWD: "دينار",
  BHD: "دينار",
  USD: "دولار",
  INR: "روبية",
  GBP: "جنيه إسترليني",
  EUR: "يورو",
};

export function formatAmountArabic(value: number, currency: string): string {
  const unit = CURRENCY_AR[currency] ?? currency;
  const trim = (n: number) => Number(n.toFixed(2)).toString();
  // One and two are said as words: "مليون ريال", "مليونين ريال", "ألف ريال", "ألفين ريال"
  if (value === 1_000_000) return `مليون ${unit}`;
  if (value === 2_000_000) return `مليونين ${unit}`;
  if (value >= 1_000_000) return `${trim(value / 1_000_000)} مليون ${unit}`;
  if (value === 1_000) return `ألف ${unit}`;
  if (value === 2_000) return `ألفين ${unit}`;
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000} ألف ${unit}`;
  return `${value.toLocaleString("en-US")} ${unit}`;
}
