import {
  type ToolCall,
  type ToolResult,
  formatDateForSpeech,
  formatFieldValue,
  formatTimeForSpeech,
  isArabic,
  zonedDateTimeToUtc,
} from "@platform/core";
import type { AgentConfig, ToolName } from "@platform/shared";
import { z } from "zod";
import type { SmtpSettings } from "./email";
import { deliverMail, type MailCredentials } from "./mailer";
import type { MicrosoftDeps } from "./microsoft";
import type { GoogleCredentials, GoogleDeps } from "./google/auth";
import { busyIntervals, deleteEvent, eventIdFor, insertEvent } from "./google/calendar";
import { appendRow } from "./google/sheets";
import {
  type Interval,
  type SlotQuery,
  checkSlot,
  describeSlots,
  explainProblem,
  freeSlots,
  nearestSlots,
  slotRules,
} from "./slots";
import { postWebhook } from "./webhook";

/** Everything a tool may know about the call or WhatsApp conversation it runs in */
export type ToolContext = {
  tenantId: string;
  /** null in a WhatsApp conversation */
  callId: string | null;
  conversationId?: string | null;
  agentId: string;
  callerNumber: string;
  timezone: string;
  config: AgentConfig;
  now: Date;
};

/** A connected integration, decrypted for this one execution */
export type ToolBinding = {
  integrationId: string;
  type: string;
  config: Record<string, unknown>;
  credentials: Record<string, unknown>;
};

/** Platform appointment book (Postgres in the API), scoped to the call's tenant and agent */
export interface BookingStore {
  /** Upcoming bookings overlapping [from, to) */
  busy(from: Date, to: Date): Promise<Interval[]>;
  /**
   * Atomically check capacity (unless null) and insert. Idempotent: the same call booking the same
   * start again returns the existing appointment.
   */
  book(a: {
    start: Date;
    end: Date;
    title: string;
    capacity: number | null;
    bufferMinutes: number;
    externalRef?: string;
    integrationId?: string;
    collected: Record<string, unknown>;
  }): Promise<{ ok: true; appointmentId: string } | { ok: false }>;
  /** Remove a booking whose external event could not be created */
  discard(appointmentId: string): Promise<void>;
  /** The caller's next upcoming appointment (matched by phone number) */
  nextForCaller(): Promise<{
    id: string;
    start: Date;
    externalRef: string | null;
    integrationId: string | null;
  } | null>;
  cancel(appointmentId: string): Promise<void>;
}

export type HandlerEnv = {
  call: ToolCall;
  ctx: ToolContext;
  binding: ToolBinding | null;
  bookings: BookingStore;
  saveLead: (collected: Record<string, unknown>) => Promise<{ leadId: string }>;
  google: GoogleDeps;
  microsoft: MicrosoftDeps;
  allowPrivateNetwork: boolean;
  timeoutMs: number;
};

type Handler = (env: HandlerEnv, input: Record<string, unknown>) => Promise<ToolResult>;

const DateStr = z.iso.date();
const TimeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const Text = (max: number) => z.string().trim().min(1).max(max);

/** Inputs after {{field}} templates are filled; `collected` is always added by the engine */
export const TOOL_INPUTS: Partial<Record<ToolName, z.ZodType<Record<string, unknown>>>> = {
  "appointments.create": z.object({ title: Text(200).optional(), date: DateStr, time: TimeStr }),
  "calendar.find_slots": z.object({ date: DateStr }),
  "calendar.book": z.object({
    title: Text(200).optional(),
    description: Text(2000).optional(),
    date: DateStr,
    time: TimeStr,
  }),
  "email.send": z.object({
    to: z.string().max(1000).optional(),
    subject: Text(200).optional(),
    body: Text(10_000).optional(),
  }),
};

const collectedOf = (input: Record<string, unknown>) =>
  input.collected && typeof input.collected === "object" ? (input.collected as Record<string, unknown>) : {};

/** "{{preferred_time}}" in the step's input → "preferred_time" (so the engine can re-ask it) */
export function sourceField(config: AgentConfig, stepId: string, inputName: string): string | undefined {
  const step = config.workflow.steps.find((s) => s.id === stepId);
  const raw =
    step && (step.type === "tool" || step.type === "confirm_and_act") ? step.input[inputName] : undefined;
  return typeof raw === "string" ? /^\{\{\s*([a-z][a-z0-9_]*)\s*\}\}$/.exec(raw)?.[1] : undefined;
}

/** "Name: Priya / Service: Cleaning / …" from the agent's own field labels */
export function callSummary(ctx: ToolContext, collected: Record<string, unknown>): string[] {
  const lines = [`Caller: ${ctx.callerNumber || "unknown"}`];
  for (const f of ctx.config.qualificationFields) {
    if (collected[f.key] !== undefined && collected[f.key] !== null)
      lines.push(`${f.label}: ${formatFieldValue(f, collected[f.key])}`);
  }
  return lines;
}

/** Local wall-clock date and time of an instant in a time zone */
export function localParts(at: Date, timezone: string): { date: string; time: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** Busy intervals are fetched for the day plus a margin (long visits, buffers) */
function dayWindow(date: string, timezone: string): { from: Date; to: Date } {
  const start = zonedDateTimeToUtc(date, "00:00", timezone);
  return { from: new Date(start.getTime() - 86_400_000), to: new Date(start.getTime() + 2 * 86_400_000) };
}

/** Spread `n` offers across the day rather than the first few minutes */
function spread(slots: string[], n: number): string[] {
  if (slots.length <= n) return slots;
  if (n === 1) return [slots[0]!];
  return [
    ...new Set(Array.from({ length: n }, (_, i) => slots[Math.round((i * (slots.length - 1)) / (n - 1))]!)),
  ];
}

function query(env: HandlerEnv, date: string, busy: Interval[]): SlotQuery {
  return {
    date,
    timezone: env.ctx.timezone,
    hours: env.ctx.config.workingHours,
    rules: slotRules(env.ctx.config),
    busy,
    now: env.ctx.now,
  };
}

/** A time that can't be booked → spoken reason, alternatives, and which answers to ask again */
function unavailable(
  env: HandlerEnv,
  q: SlotQuery,
  time: string,
  problem: Parameters<typeof explainProblem>[0],
): ToolResult {
  const rules = slotRules(env.ctx.config);
  const dateField = sourceField(env.ctx.config, env.call.stepId, "date");
  const timeField = sourceField(env.ctx.config, env.call.stepId, "time");
  const sameDay = problem !== "too_far" && problem !== "in_the_past";
  const alternatives = sameDay ? nearestSlots(freeSlots(q), time, rules.slotsToOffer) : [];
  const retry = alternatives.length ? [timeField] : [dateField, timeField];
  return {
    ok: false,
    error: problem === "taken" ? "slot_unavailable" : problem,
    message: explainProblem(problem, q.date, time, alternatives, env.ctx.config.language),
    retryFields: retry.filter((k): k is string => Boolean(k)),
  };
}

const googleCreds = (b: ToolBinding) => b.credentials as GoogleCredentials;
const calendarRef = (b: ToolBinding) => ({
  credentials: googleCreds(b),
  calendarId: String(b.config.calendarId ?? "primary"),
});

export const HANDLERS: Partial<Record<ToolName, Handler>> = {
  "leads.create": async (env, input) => {
    const { leadId } = await env.saveLead(collectedOf(input));
    return { ok: true, data: { leadId } };
  },

  "appointments.create": async (env, input) => {
    const { date, time } = input as { date: string; time: string; title?: string };
    const rules = slotRules(env.ctx.config);
    const w = dayWindow(date, env.ctx.timezone);
    const q = query(env, date, await env.bookings.busy(w.from, w.to));
    const check = checkSlot(q, time);
    if (check.problem) return unavailable(env, q, time, check.problem);
    const booked = await env.bookings.book({
      start: check.start,
      end: check.end,
      title: (input.title as string | undefined) ?? "Appointment",
      capacity: rules.capacity,
      bufferMinutes: rules.bufferMinutes,
      collected: collectedOf(input),
    });
    if (!booked.ok) {
      // Someone else took it a moment ago
      const again = query(env, date, await env.bookings.busy(w.from, w.to));
      return unavailable(env, again, time, "taken");
    }
    return { ok: true, data: { appointmentId: booked.appointmentId } };
  },

  "calendar.find_slots": async (env, input) => {
    const date = input.date as string;
    const w = dayWindow(date, env.ctx.timezone);
    const busy = await busyIntervals(calendarRef(env.binding!), w.from, w.to, env.google, env.ctx.timezone);
    const slots = freeSlots(query(env, date, busy));
    if (!slots.length) {
      const dateField = sourceField(env.ctx.config, env.call.stepId, "date");
      return {
        ok: false,
        error: "no_slots",
        message: isArabic(env.ctx.config.language)
          ? "ما عندي أوقات فاضية ذاك اليوم."
          : "I don't have any free times on that day.",
        retryFields: dateField ? [dateField] : [],
      };
    }
    const offer = spread(slots, slotRules(env.ctx.config).slotsToOffer);
    return { ok: true, data: { slots }, message: describeSlots(date, offer, env.ctx.config.language) };
  },

  "calendar.book": async (env, input) => {
    const { date, time } = input as { date: string; time: string };
    const rules = slotRules(env.ctx.config);
    const b = env.binding!;
    const w = dayWindow(date, env.ctx.timezone);
    const q = query(
      env,
      date,
      await busyIntervals(calendarRef(b), w.from, w.to, env.google, env.ctx.timezone),
    );
    const check = checkSlot(q, time);
    if (check.problem) return unavailable(env, q, time, check.problem);

    const collected = collectedOf(input);
    const eventId = eventIdFor(`${env.ctx.tenantId}:${env.call.idempotencyKey}`);
    const title = (input.title as string | undefined) ?? `${env.ctx.config.businessName} appointment`;
    // Reserve in the platform first: concurrent calls to our agents can't take the same slot
    const booked = await env.bookings.book({
      start: check.start,
      end: check.end,
      title,
      capacity: rules.capacity,
      bufferMinutes: rules.bufferMinutes,
      externalRef: eventId,
      integrationId: b.integrationId,
      collected,
    });
    if (!booked.ok) return unavailable(env, q, time, "taken");
    try {
      await insertEvent(
        calendarRef(b),
        {
          id: eventId,
          summary: title,
          description: [(input.description as string | undefined) ?? "", ...callSummary(env.ctx, collected)]
            .filter(Boolean)
            .join("\n"),
          start: check.start,
          end: check.end,
          timezone: env.ctx.timezone,
        },
        env.google,
      );
    } catch (err) {
      await env.bookings.discard(booked.appointmentId);
      throw err;
    }
    return { ok: true, data: { appointmentId: booked.appointmentId, eventId } };
  },

  "calendar.cancel": async (env) => {
    const next = await env.bookings.nextForCaller();
    if (!next) {
      return {
        ok: false,
        error: "no_appointment",
        message: isArabic(env.ctx.config.language)
          ? "ما لقيت موعد قادم على هالرقم."
          : "I couldn't find an upcoming appointment for this phone number.",
      };
    }
    if (next.externalRef && env.binding)
      await deleteEvent(calendarRef(env.binding), next.externalRef, env.google);
    await env.bookings.cancel(next.id);
    const { date, time } = localParts(next.start, env.ctx.timezone);
    return {
      ok: true,
      data: { appointmentId: next.id },
      message: isArabic(env.ctx.config.language)
        ? `ألغيت موعدك ${describeWhen(date, time, env.ctx.config.language)}.`
        : `I've cancelled your appointment on ${describeWhen(date, time)}.`,
    };
  },

  "sheets.append_row": async (env, input) => {
    const b = env.binding!;
    const collected = collectedOf(input);
    const { collected: _c, ...explicit } = input;
    const values: (string | number | boolean)[] = Object.keys(explicit).length
      ? Object.values(explicit).map((v) =>
          typeof v === "object" ? JSON.stringify(v) : (v as string | number | boolean),
        )
      : env.ctx.config.qualificationFields.map((f) =>
          collected[f.key] === undefined ? "" : formatFieldValue(f, collected[f.key]),
        );
    const now = localParts(env.ctx.now, env.ctx.timezone);
    await appendRow(
      {
        credentials: googleCreds(b),
        spreadsheetId: String(b.config.spreadsheetId),
        sheetName: String(b.config.sheetName ?? "Sheet1"),
      },
      [`${now.date} ${now.time}`, env.ctx.callerNumber, ...values],
      env.google,
    );
    return { ok: true };
  },

  "email.send": async (env, input) => {
    const b = env.binding!;
    const settings = b.config as unknown as SmtpSettings;
    const requested = typeof input.to === "string" ? input.to.split(/[,;\s]+/).filter(Boolean) : [];
    const to = requested.length ? requested : settings.defaultTo;
    if (!to.length || to.some((a) => !z.email().safeParse(a).success))
      return { ok: false, error: "invalid_recipient" };
    const collected = collectedOf(input);
    await deliverMail(
      b.credentials as unknown as MailCredentials,
      settings,
      {
        to: to.slice(0, 5),
        subject: (input.subject as string | undefined) ?? `New call for ${env.ctx.config.businessName}`,
        text: (input.body as string | undefined) ?? callSummary(env.ctx, collected).join("\n"),
      },
      {
        allowPrivateNetwork: env.allowPrivateNetwork,
        timeoutMs: env.timeoutMs,
        idempotencyKey: env.call.idempotencyKey,
        google: env.google,
        microsoft: env.microsoft,
      },
    );
    return { ok: true };
  },

  "webhook.post": async (env, input) => {
    const b = env.binding!;
    const { collected: _c, ...data } = input;
    await postWebhook(
      String(b.config.url),
      String(b.credentials.secret),
      {
        event: "call.tool",
        occurredAt: env.ctx.now.toISOString(),
        callId: env.ctx.callId,
        ...(env.ctx.conversationId ? { conversationId: env.ctx.conversationId, channel: "whatsapp" } : {}),
        agentId: env.ctx.agentId,
        stepId: env.call.stepId,
        callerNumber: env.ctx.callerNumber,
        data,
        collected: collectedOf(input),
      },
      {
        allowPrivateNetwork: env.allowPrivateNetwork,
        timeoutMs: env.timeoutMs,
        idempotencyKey: env.call.idempotencyKey,
      },
    );
    return { ok: true };
  },
};

function describeWhen(date: string, time: string, language?: string): string {
  return isArabic(language)
    ? `يوم ${formatDateForSpeech(date, language)} الساعة ${formatTimeForSpeech(time, language)}`
    : `${formatDateForSpeech(date)} at ${formatTimeForSpeech(time)}`;
}
