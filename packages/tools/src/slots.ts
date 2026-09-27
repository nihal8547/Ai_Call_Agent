import {
  formatDateForSpeech,
  formatTimeForSpeech,
  isArabic,
  isOpen,
  zonedDateTimeToUtc,
} from "@platform/core";
import { AppointmentConfig, type AgentConfig, type WorkingHours } from "@platform/shared";

export type Interval = { start: Date; end: Date };
export type SlotRules = ReturnType<typeof AppointmentConfig.parse>;

/** Hours used to suggest times when the business has not configured any */
const DEFAULT_DAY = [{ start: "09:00", end: "18:00" }];
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export const slotRules = (config: AgentConfig): SlotRules =>
  config.appointment ?? AppointmentConfig.parse({});

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export type SlotProblem = "in_the_past" | "too_soon" | "too_far" | "closed" | "taken";

export type SlotQuery = {
  date: string;
  timezone: string;
  hours: WorkingHours | undefined;
  rules: SlotRules;
  /** Existing bookings/events that day (each counts against capacity) */
  busy: Interval[];
  now: Date;
  /** Treat the calendar as single-capacity (merged busy time, e.g. a personal calendar) */
  capacity?: number;
};

function openingRanges(q: Pick<SlotQuery, "date" | "hours">): { start: string; end: string }[] {
  if (!q.hours) return DEFAULT_DAY;
  if (q.hours.holidays.includes(q.date)) return [];
  const [y, m, d] = q.date.split("-").map(Number);
  const day = DAY_KEYS[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]!;
  return q.hours.days[day] ?? [];
}

/** Why a specific time cannot be booked (null = bookable) */
export function checkSlot(
  q: SlotQuery,
  time: string,
): { problem: SlotProblem | null; start: Date; end: Date } {
  const { rules } = q;
  const start = zonedDateTimeToUtc(q.date, time, q.timezone);
  const end = new Date(start.getTime() + rules.durationMinutes * 60_000);
  const at = (problem: SlotProblem | null) => ({ problem, start, end });
  if (start.getTime() <= q.now.getTime()) return at("in_the_past");
  if (start.getTime() < q.now.getTime() + rules.leadTimeMinutes * 60_000) return at("too_soon");
  if (start.getTime() > q.now.getTime() + rules.maxDaysAhead * 86_400_000) return at("too_far");
  // The whole visit must fit in opening hours (no hours configured = any time the caller asks for)
  if (q.hours && !(isOpen(q.hours, start) && isOpen(q.hours, new Date(end.getTime() - 60_000))))
    return at("closed");
  const buffer = rules.bufferMinutes * 60_000;
  const overlapping = q.busy.filter(
    (b) => b.start.getTime() < end.getTime() + buffer && b.end.getTime() > start.getTime() - buffer,
  ).length;
  if (overlapping >= (q.capacity ?? rules.capacity)) return at("taken");
  return at(null);
}

/** Every bookable start time on the day, on the configured grid */
export function freeSlots(q: SlotQuery): string[] {
  const out: string[] = [];
  const step = q.rules.slotStepMinutes;
  for (const r of openingRanges(q)) {
    const first = Math.ceil(toMinutes(r.start) / step) * step;
    for (let m = first; m + q.rules.durationMinutes <= toMinutes(r.end); m += step) {
      const t = toHhmm(m);
      if (checkSlot(q, t).problem === null) out.push(t);
    }
  }
  return [...new Set(out)].sort();
}

/** The `n` free times closest to what the caller asked for (or the earliest ones) */
export function nearestSlots(slots: string[], requested: string | undefined, n: number): string[] {
  if (!requested) return slots.slice(0, n);
  const r = toMinutes(requested);
  return [...slots]
    .sort((a, b) => Math.abs(toMinutes(a) - r) - Math.abs(toMinutes(b) - r) || a.localeCompare(b))
    .slice(0, n)
    .sort();
}

const list = (items: string[], or = "or") =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${or} ${items[items.length - 1]}`;

/** "On Tuesday, 29 September I have 11 AM or 3 PM free." (Arabic agents say it in Arabic) */
export function describeSlots(date: string, slots: string[], language?: string): string {
  const day = formatDateForSpeech(date, language);
  const times = slots.map((t) => formatTimeForSpeech(t, language));
  return isArabic(language)
    ? `يوم ${day} عندي ${list(times, "أو")} فاضي.`
    : `On ${day} I have ${list(times)} free.`;
}

/** What to tell a caller whose time can't be booked, with alternatives when there are any */
export function explainProblem(
  problem: SlotProblem,
  date: string,
  time: string,
  alternatives: string[],
  language?: string,
): string {
  const ar = isArabic(language);
  const when = ar
    ? `الساعة ${formatTimeForSpeech(time, language)} يوم ${formatDateForSpeech(date, language)}`
    : `${formatTimeForSpeech(time)} on ${formatDateForSpeech(date)}`;
  const reason: Record<SlotProblem, string> = ar
    ? {
        taken: `${when} محجوزة.`,
        closed: `إحنا مسكّرين ${when}.`,
        in_the_past: `${when} راحت خلاص.`,
        too_soon: `${when} قريبة شوي علينا نتجهز.`,
        too_far: "ما نقدر نحجز لهالمدة البعيدة الحين.",
      }
    : {
        taken: `${when} is already booked.`,
        closed: `We're closed at ${when}.`,
        in_the_past: `${when} has already passed.`,
        too_soon: `${when} is a little too soon for us to prepare.`,
        too_far: `We can't book that far ahead yet.`,
      };
  // No question here: the agent asks for the time (or day) again right after
  const alt = alternatives.length
    ? ` ${describeSlots(date, alternatives, language)}`
    : ar
      ? " ما عندي أوقات فاضية ذاك اليوم."
      : " I don't have any free times that day.";
  return reason[problem] + alt;
}
