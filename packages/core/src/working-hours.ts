import type { WorkingHours } from "@platform/shared";

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Is the business open at `now`, in its own time zone? No working hours configured = always open. */
export function isOpen(hours: WorkingHours | undefined, now: Date): boolean {
  if (!hours) return true;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: hours.timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  if (hours.holidays.includes(date)) return false;
  const day = DAY_KEYS.find((d) => d === parts.weekday?.toLowerCase().slice(0, 3));
  const ranges = day ? hours.days[day] : undefined;
  const hhmm = `${parts.hour}:${parts.minute}`;
  return Boolean(ranges?.some((r) => hhmm >= r.start && hhmm < r.end));
}
