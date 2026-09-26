import { normalizeUtterance } from "./text";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const MONTH_RE =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const ORD_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  "twenty first": 21,
  "twenty second": 22,
  "twenty third": 23,
  "twenty fourth": 24,
  "twenty fifth": 25,
  "twenty sixth": 26,
  "twenty seventh": 27,
  "twenty eighth": 28,
  "twenty ninth": 29,
  thirtieth: 30,
  "thirty first": 31,
};

type YMD = { y: number; m: number; d: number };

/** Today's calendar date in a time zone */
export function todayIn(timezone: string, now: Date): YMD {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}

const toISO = ({ y, m, d }: YMD) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const addDays = (date: YMD, days: number): YMD => {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const weekday = (date: YMD) => new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
const isValid = ({ y, m, d }: YMD) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const monthIndex = (name: string) => MONTHS.findIndex((m) => m.startsWith(name.slice(0, 3))) + 1;

/**
 * Parse a spoken date relative to "today" in the business time zone → "YYYY-MM-DD".
 * Handles today/tomorrow/day after tomorrow, weekdays ("next Monday", "this Friday"), "in 3 days",
 * "12th October", "October 12", "12/10" (day/month), ISO dates. Dates without a year roll forward.
 */
export function parseDate(input: string, ctx: { timezone: string; now: Date }): string | undefined {
  const text = normalizeUtterance(input).replace(/,/g, " ");
  const today = todayIn(ctx.timezone, ctx.now);

  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const date = { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
    return isValid(date) ? toISO(date) : undefined;
  }
  if (/\bday after tomorrow\b/.test(text)) return toISO(addDays(today, 2));
  if (/\b(tomorrow|tmrw|tomorow)\b/.test(text)) return toISO(addDays(today, 1));
  if (/\b(today|tonight|this evening|this afternoon|this morning)\b/.test(text)) return toISO(today);

  const inDays = text.match(/\bin (\d+|a|one|two|three|four|five|six|seven) days?\b/);
  if (inDays) {
    const n =
      { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 }[inDays[1]!] ?? Number(inDays[1]);
    return toISO(addDays(today, n));
  }
  if (/\bnext week\b/.test(text) && !WEEKDAYS.some((w) => text.includes(w))) return toISO(addDays(today, 7));

  const wd = text.match(
    /\b(?:(next|this|coming)\s+)?(sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?\b/,
  );
  if (wd) {
    const target = WEEKDAYS.findIndex((w) => w.startsWith(wd[2]!.slice(0, 3)));
    let diff = (target - weekday(today) + 7) % 7;
    if (diff === 0) diff = wd[1] === "this" ? 0 : 7;
    else if (wd[1] === "next" && diff < 7 && /\bnext week\b/.test(text)) diff += 7;
    return toISO(addDays(today, diff));
  }

  const withYear = (m: number, d: number, y?: number): string | undefined => {
    let date: YMD = { y: y ?? today.y, m, d };
    if (!isValid(date)) return undefined;
    if (!y && toISO(date) < toISO(today)) date = { ...date, y: date.y + 1 };
    return toISO(date);
  };

  // "12th october", "12 oct 2026", "the twelfth of october"
  const dm = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${MONTH_RE}(?: (\\d{4}))?\\b`));
  if (dm) return withYear(monthIndex(dm[2]!), Number(dm[1]), dm[3] ? Number(dm[3]) : undefined);
  // "october 12", "oct 12th 2026"
  const md = text.match(new RegExp(`\\b${MONTH_RE} (\\d{1,2})(?:st|nd|rd|th)?(?: (\\d{4}))?\\b`));
  if (md) return withYear(monthIndex(md[1]!), Number(md[2]), md[3] ? Number(md[3]) : undefined);
  for (const [word, n] of Object.entries(ORD_WORDS).sort((a, b) => b[0].length - a[0].length)) {
    const ow = text.match(new RegExp(`\\b(?:the )?${word}(?: of)? ${MONTH_RE}\\b`));
    if (ow) return withYear(monthIndex(ow[1]!), n);
  }
  // "12/10" or "12-10-2026" (day first)
  const num = text.match(/\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/);
  if (num) {
    const y = num[3] ? Number(num[3].length === 2 ? `20${num[3]}` : num[3]) : undefined;
    return withYear(Number(num[2]), Number(num[1]), y);
  }
  // "on the 15th" → this month (or next if passed)
  const dayOnly = text.match(/\b(?:the )?(\d{1,2})(?:st|nd|rd|th)\b/);
  if (dayOnly) {
    const d = Number(dayOnly[1]);
    let date: YMD = { ...today, d };
    if (!isValid(date)) return undefined;
    if (toISO(date) < toISO(today))
      date = today.m === 12 ? { y: today.y + 1, m: 1, d } : { y: today.y, m: today.m + 1, d };
    return isValid(date) ? toISO(date) : undefined;
  }
  return undefined;
}

const HOUR_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/**
 * Parse a spoken time → "HH:MM" (24h): "5 pm", "5:30pm", "17:30", "half past five", "quarter to six",
 * "morning" (10:00), "afternoon" (14:00), "evening" (17:00), "noon". Bare hours 1–7 are read as PM
 * (business hours), 8–11 as AM.
 */
export function parseTime(input: string): string | undefined {
  const text = normalizeUtterance(input)
    .replace(/\./g, "")
    .replace(/\bo'?clock\b/g, "");
  const fmt = (h: number, m: number) =>
    h >= 0 && h < 24 && m >= 0 && m < 60
      ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
      : undefined;
  const meridiem = (h: number, suffix: string | undefined, rest: string): number => {
    const pm = suffix === "pm" || /\b(evening|afternoon|night|tonight)\b/.test(rest);
    const am = suffix === "am" || /\bmorning\b/.test(rest);
    if (pm && h < 12) return h + 12;
    if (am && h === 12) return 0;
    if (!pm && !am && h >= 1 && h <= 7) return h + 12;
    return h;
  };
  const word = (w: string) => HOUR_WORDS[w] ?? (/^\d{1,2}$/.test(w) ? Number(w) : undefined);

  const half = text.match(/\bhalf past (\w+)/);
  if (half && word(half[1]!) !== undefined) return fmt(meridiem(word(half[1]!)!, undefined, text), 30);
  const qp = text.match(/\bquarter past (\w+)/);
  if (qp && word(qp[1]!) !== undefined) return fmt(meridiem(word(qp[1]!)!, undefined, text), 15);
  const qt = text.match(/\bquarter to (\w+)/);
  if (qt && word(qt[1]!) !== undefined) return fmt(meridiem(word(qt[1]!)! - 1, undefined, text), 45);

  const hm = text.match(/\b(\d{1,2})[:h](\d{2})\s*(am|pm|a m|p m)?\b/);
  if (hm) {
    const h = Number(hm[1]);
    const suffix = hm[3]?.replace(" ", "");
    return fmt(h > 12 ? h : meridiem(h, suffix, text), Number(hm[2]));
  }
  const h = text.match(
    /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?: (thirty|fifteen|forty five))?\s*(am|pm|a m|p m)?\b/,
  );
  if (
    h &&
    (h[3] ||
      /\b(at|around|by|about|evening|morning|afternoon|night)\b/.test(text) ||
      text.split(" ").length <= 3)
  ) {
    const hour = word(h[1]!);
    if (hour !== undefined && hour <= 23) {
      const minutes = h[2] === "thirty" ? 30 : h[2] === "fifteen" ? 15 : h[2] === "forty five" ? 45 : 0;
      return fmt(hour > 12 ? hour : meridiem(hour, h[3]?.replace(" ", ""), text), minutes);
    }
  }
  if (/\bnoon|midday\b/.test(text)) return "12:00";
  if (/\bmorning\b/.test(text)) return "10:00";
  if (/\bafternoon\b/.test(text)) return "14:00";
  if (/\b(evening|tonight)\b/.test(text)) return "17:00";
  return undefined;
}

/** "2026-10-12" → "Monday, 12 October" */
export function formatDateForSpeech(iso: string, locale = "en-IN"): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

/** "17:30" → "5:30 PM" */
export function formatTimeForSpeech(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h! >= 12 ? "PM" : "AM";
  const hour = h! % 12 === 0 ? 12 : h! % 12;
  return m ? `${hour}:${String(m).padStart(2, "0")} ${suffix}` : `${hour} ${suffix}`;
}
