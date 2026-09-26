/** Pass the business time zone for business-local times (appointments); omit for the viewer's local time */
export const fmtDateTime = (iso: string | null | undefined, timeZone?: string) =>
  iso
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        ...(timeZone ? { timeZone } : {}),
      }).format(new Date(iso))
    : "—";

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

export const fmtDuration = (sec: number | null | undefined) => {
  if (sec === null || sec === undefined) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
};

export const fmtCompact = (n: number) =>
  new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
export const fmtPercent = (x: number) => `${Math.round(x * 100)}%`;

/** "APPOINTMENT_BOOKED" → "Appointment booked" */
export const humanize = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");

/** Show collected values nicely: ISO dates, times, big amounts */
export function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return v >= 100000 ? new Intl.NumberFormat("en-IN").format(v) : String(v);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split("-").map(Number);
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(y!, m! - 1, d!)));
  }
  return String(v);
}

/** 1536 → "1.5 KB" */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** Where a search hit or chunk came from: "Page 3 · Pricing › Implants" */
export function fmtSource(meta: {
  page?: number;
  pages?: number[];
  headingPath?: string[];
  sheet?: string;
  rows?: [number, number];
}): string {
  const parts: string[] = [];
  if (meta.pages?.length) parts.push(`Pages ${meta.pages[0]}–${meta.pages[meta.pages.length - 1]}`);
  else if (meta.page !== undefined) parts.push(`Page ${meta.page}`);
  if (meta.sheet) parts.push(`Sheet ${meta.sheet}`);
  if (meta.rows) parts.push(`Rows ${meta.rows[0]}–${meta.rows[1]}`);
  if (meta.headingPath?.length) parts.push(meta.headingPath.join(" › "));
  return parts.join(" · ");
}

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso)) : "—";
