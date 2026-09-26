/** Calendar maths in the business time zone (appointments are shown in the business's time, not the viewer's) */

const parts = (at: Date, timeZone: string) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;

/** "YYYY-MM-DD" of an instant in a time zone */
export function localDate(at: Date, timeZone: string): string {
  const p = parts(at, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "HH:MM" of an instant in a time zone */
export function localTime(at: Date, timeZone: string): string {
  const p = parts(at, timeZone);
  return `${p.hour}:${p.minute}`;
}

/** Calendar arithmetic on "YYYY-MM-DD" strings (no time zone involved) */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** Monday of the week containing `date` */
export function weekStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

/** The instant a wall-clock time happens in a time zone (DST-safe) */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const naive = Date.UTC(y!, m! - 1, d!, h!, mi!);
  const offset = (at: number) => {
    const p = parts(new Date(at), timeZone);
    return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - at;
  };
  let utc = naive - offset(naive);
  utc = naive - offset(utc);
  return new Date(utc);
}
