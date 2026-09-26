import { zonedDateTimeToUtc } from "@platform/core";
import { createHash } from "node:crypto";
import {
  type GoogleCredentials,
  type GoogleDeps,
  SCOPES,
  googleAccessToken,
  googleError,
  googleJson,
} from "./auth";
import type { Interval } from "../slots";

const API = "https://www.googleapis.com/calendar/v3";

export type CalendarRef = { credentials: GoogleCredentials; calendarId: string };

type GEvent = {
  id: string;
  status?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};

const cal = (calendarId: string) => `${API}/calendars/${encodeURIComponent(calendarId)}`;

/**
 * Busy time from individual events (so several bookings at once can count against a capacity).
 * Cancelled and "free" events are ignored; all-day events block their days.
 */
export async function busyIntervals(
  ref: CalendarRef,
  from: Date,
  to: Date,
  deps: GoogleDeps,
  timezone: string,
): Promise<Interval[]> {
  const token = await googleAccessToken(ref.credentials, SCOPES.calendar, deps);
  const q = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
    timeZone: timezone,
    fields: "items(id,status,transparency,start,end)",
  });
  const { status, data } = await googleJson<{ items?: GEvent[] }>(
    deps,
    token,
    `${cal(ref.calendarId)}/events?${q}`,
  );
  if (status !== 200) throw googleError(status, data, "Reading the calendar failed");
  return (data.items ?? [])
    .filter((e) => e.status !== "cancelled" && e.transparency !== "transparent")
    .map((e) => ({ start: when(e.start, timezone), end: when(e.end, timezone) }))
    .filter((i) => !Number.isNaN(i.start.getTime()) && !Number.isNaN(i.end.getTime()));
}

/** A timed event's instant, or an all-day event's local midnight */
function when(t: GEvent["start"], timezone: string): Date {
  if (t?.dateTime) return new Date(t.dateTime);
  if (t?.date && /^\d{4}-\d{2}-\d{2}$/.test(t.date)) return zonedDateTimeToUtc(t.date, "00:00", timezone);
  return new Date(Number.NaN);
}

/** Google event ids: base32hex (0-9, a-v), 5–1024 chars. Hex digits qualify. */
export function eventIdFor(idempotencyKey: string): string {
  return `ap${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 40)}`;
}

/**
 * Create the event with an id derived from the tool call, so a retry can never double-book:
 * a 409 means our earlier attempt already created it.
 */
export async function insertEvent(
  ref: CalendarRef,
  ev: { id: string; summary: string; description: string; start: Date; end: Date; timezone: string },
  deps: GoogleDeps,
): Promise<{ id: string }> {
  const token = await googleAccessToken(ref.credentials, SCOPES.calendar, deps);
  const { status, data } = await googleJson<{ id?: string }>(deps, token, `${cal(ref.calendarId)}/events`, {
    method: "POST",
    body: {
      id: ev.id,
      summary: ev.summary.slice(0, 200),
      description: ev.description.slice(0, 4000),
      start: { dateTime: ev.start.toISOString(), timeZone: ev.timezone },
      end: { dateTime: ev.end.toISOString(), timeZone: ev.timezone },
      reminders: { useDefault: true },
    },
  });
  if (status === 200 || status === 409) return { id: data.id ?? ev.id };
  throw googleError(status, data, "Creating the event failed");
}

export async function deleteEvent(ref: CalendarRef, eventId: string, deps: GoogleDeps): Promise<void> {
  const token = await googleAccessToken(ref.credentials, SCOPES.calendar, deps);
  const { status, data } = await googleJson(
    deps,
    token,
    `${cal(ref.calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE" },
  );
  if (status === 204 || status === 200 || status === 404 || status === 410) return; // already gone
  throw googleError(status, data, "Cancelling the event failed");
}

export async function moveEvent(
  ref: CalendarRef,
  eventId: string,
  start: Date,
  end: Date,
  timezone: string,
  deps: GoogleDeps,
): Promise<void> {
  const token = await googleAccessToken(ref.credentials, SCOPES.calendar, deps);
  const { status, data } = await googleJson(
    deps,
    token,
    `${cal(ref.calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      body: {
        start: { dateTime: start.toISOString(), timeZone: timezone },
        end: { dateTime: end.toISOString(), timeZone: timezone },
      },
    },
  );
  if (status !== 200) throw googleError(status, data, "Moving the event failed");
}

/** Can we read this calendar? (connection test) */
export async function checkCalendar(ref: CalendarRef, deps: GoogleDeps): Promise<{ summary: string }> {
  const token = await googleAccessToken(ref.credentials, SCOPES.calendar, deps);
  const { status, data } = await googleJson<{ summary?: string }>(
    deps,
    token,
    `${cal(ref.calendarId)}?fields=summary`,
  );
  if (status !== 200) throw googleError(status, data, "Opening the calendar failed");
  return { summary: data.summary ?? ref.calendarId };
}
