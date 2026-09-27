import type { WorkingHours } from "@platform/shared";

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

type Range = { start: string; end: string };

/**
 * Opening ranges on a calendar date (`YYYY-MM-DD`, the business's own date): a holiday is closed,
 * a special date range (Ramadan, Eid …) replaces the weekly hours, otherwise the weekday's hours.
 */
export function hoursOn(hours: WorkingHours, date: string): Range[] {
  if (hours.holidays.includes(date)) return [];
  const special = hours.dateRangeOverrides?.find((o) => date >= o.startDate && date <= o.endDate);
  if (special) return special.hours;
  const [y, m, d] = date.split("-").map(Number);
  const day = DAY_KEYS[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]!;
  return hours.days[day] ?? [];
}

/** Is the business open at `now`, in its own time zone? No working hours configured = always open. */
export function isOpen(hours: WorkingHours | undefined, now: Date): boolean {
  if (!hours) return true;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: hours.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  const hhmm = `${parts.hour}:${parts.minute}`;
  return hoursOn(hours, `${parts.year}-${parts.month}-${parts.day}`).some(
    (r) => hhmm >= r.start && hhmm < r.end,
  );
}
