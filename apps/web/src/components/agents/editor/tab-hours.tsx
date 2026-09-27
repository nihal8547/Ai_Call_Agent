"use client";

import {
  type AgentConfig,
  AppointmentConfig,
  ARABIC_MESSAGES,
  type Day,
  FallbackMessages,
} from "@platform/shared";
import { Button } from "@/components/ui/button";
import { useMe } from "@/components/app/me-context";
import { SelectField, TextField } from "@/components/ui/field";
import { Check, Section } from "@/components/ui/inputs";
import { useDraft } from "./draft-context";

const DAYS: [Day, string][] = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
];

const MESSAGE_LABELS: Record<keyof AgentConfig["messages"], string> = {
  didNotHear: "When the caller is silent",
  didNotUnderstand: "When an answer is unclear",
  safeAnswer: "When a question can't be answered from your knowledge",
  goodbye: "Standard goodbye",
  notInterested: "When the caller is not interested",
  noResponse: "Ending after repeated silence",
  technicalIssue: "Technical problem",
  actionFailed: "When a booking or action fails",
  declined: "When the caller says “no” to a confirmation",
};

const BOOKING_DEFAULTS = AppointmentConfig.parse({});
const BOOKING_FIELDS: [keyof typeof BOOKING_DEFAULTS, string, string][] = [
  ["durationMinutes", "Length of a visit (minutes)", ""],
  ["bufferMinutes", "Gap between visits (minutes)", ""],
  ["capacity", "Bookings at the same time", "1 = no overlaps; e.g. tables or chairs"],
  ["leadTimeMinutes", "Earliest booking (minutes ahead)", ""],
  ["maxDaysAhead", "Book up to (days ahead)", ""],
  ["slotStepMinutes", "Offer times every (minutes)", ""],
  ["slotsToOffer", "Free times offered at once", "When the asked time is taken"],
];

export function HoursTab() {
  const me = useMe();
  const { config, update, errorFor } = useDraft();
  const wh = config.workingHours;

  return (
    <div className="space-y-6">
      <Section
        title="Working hours"
        description="Outside these hours the agent never transfers calls or books appointments."
      >
        <Check
          label="Set working hours"
          checked={Boolean(wh)}
          onChange={(v) =>
            update((c) => {
              c.workingHours = v
                ? {
                    timezone: me.tenant.timezone,
                    days: Object.fromEntries(
                      DAYS.slice(0, 5).map(([d]) => [d, [{ start: "09:00", end: "18:00" }]]),
                    ),
                    holidays: [],
                    dateRangeOverrides: [],
                    offHours: "take_message",
                    offHoursMessage:
                      "Our office is closed right now, but I can take your details and the team will call you back.",
                  }
                : undefined;
            })
          }
        />
        {wh ? (
          <div className="mt-4 space-y-4">
            <TextField
              label="Time zone"
              value={wh.timezone}
              error={errorFor("workingHours.timezone")}
              onChange={(e) => update((c) => void (c.workingHours!.timezone = e.target.value))}
            />
            <table className="w-full max-w-lg text-sm">
              <tbody>
                {DAYS.map(([d, label]) => {
                  const range = wh.days[d]?.[0];
                  return (
                    <tr key={d} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                      <td className="py-2 pr-3">
                        <Check
                          label={label}
                          checked={Boolean(range)}
                          onChange={(v) =>
                            update((c) => {
                              if (v) c.workingHours!.days[d] = [{ start: "09:00", end: "18:00" }];
                              else delete c.workingHours!.days[d];
                            })
                          }
                        />
                      </td>
                      <td className="py-2">
                        {range ? (
                          <span className="flex items-center gap-2">
                            <input
                              type="time"
                              aria-label={`${label} opens`}
                              value={range.start}
                              onChange={(e) =>
                                update((c) => void (c.workingHours!.days[d]![0]!.start = e.target.value))
                              }
                              className="h-9 rounded-md border border-slate-300 bg-white px-2 dark:border-slate-700 dark:bg-slate-900"
                            />
                            –
                            <input
                              type="time"
                              aria-label={`${label} closes`}
                              value={range.end}
                              onChange={(e) =>
                                update((c) => void (c.workingHours!.days[d]![0]!.end = e.target.value))
                              }
                              className="h-9 rounded-md border border-slate-300 bg-white px-2 dark:border-slate-700 dark:bg-slate-900"
                            />
                            {errorFor(`workingHours.days.${d}.0.end`) ? (
                              <span className="text-red-600">{errorFor(`workingHours.days.${d}.0.end`)}</span>
                            ) : null}
                          </span>
                        ) : (
                          <span className="text-slate-500">Closed</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <TextField
              label="Holidays (YYYY-MM-DD, comma separated)"
              value={wh.holidays.join(", ")}
              error={errorFor("workingHours.holidays")}
              onChange={(e) =>
                update(
                  (c) =>
                    void (c.workingHours!.holidays = e.target.value
                      .split(",")
                      .map((x) => x.trim())
                      .filter(Boolean)),
                )
              }
            />

            <div className="space-y-3">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-slate-900">Special periods</p>
                  <p className="text-sm text-slate-500">
                    Ramadan, Eid or other dates with different hours. They replace the weekly hours for calls
                    and bookings; a period with no hours is closed.
                  </p>
                </div>
                {(wh.dateRangeOverrides ?? []).length < 20 ? (
                  <Button
                    variant="secondary"
                    className="shrink-0"
                    onClick={() =>
                      update((c) => {
                        const today = new Date().toISOString().slice(0, 10);
                        c.workingHours!.dateRangeOverrides = [
                          ...(c.workingHours!.dateRangeOverrides ?? []),
                          {
                            name: "Ramadan",
                            startDate: today,
                            endDate: today,
                            hours: [{ start: "10:00", end: "14:00" }],
                          },
                        ];
                      })
                    }
                  >
                    Add period
                  </Button>
                ) : null}
              </div>
              {(wh.dateRangeOverrides ?? []).map((period, i) => {
                const path = `workingHours.dateRangeOverrides.${i}`;
                const set = (
                  fn: (p: NonNullable<AgentConfig["workingHours"]>["dateRangeOverrides"][number]) => void,
                ) => update((c) => void fn(c.workingHours!.dateRangeOverrides[i]!));
                return (
                  <div key={i} className="space-y-3 rounded-lg border border-slate-200 p-4">
                    <div className="grid gap-3 sm:grid-cols-[1fr_170px_170px_auto] sm:items-start">
                      <TextField
                        label="Name"
                        value={period.name}
                        maxLength={80}
                        error={errorFor(`${path}.name`)}
                        onChange={(e) => set((p) => void (p.name = e.target.value))}
                      />
                      <TextField
                        label="From"
                        type="date"
                        value={period.startDate}
                        error={errorFor(`${path}.startDate`)}
                        onChange={(e) => set((p) => void (p.startDate = e.target.value))}
                      />
                      <TextField
                        label="To"
                        type="date"
                        value={period.endDate}
                        min={period.startDate}
                        error={errorFor(`${path}.endDate`)}
                        onChange={(e) => set((p) => void (p.endDate = e.target.value))}
                      />
                      <Button
                        variant="ghost"
                        className="h-9 px-2 text-red-600 sm:mt-7"
                        onClick={() => update((c) => void c.workingHours!.dateRangeOverrides.splice(i, 1))}
                      >
                        Remove
                      </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                      {period.hours.length === 0 ? (
                        <span className="text-slate-500">Closed all day</span>
                      ) : null}
                      {period.hours.map((r, j) => (
                        <span key={j} className="flex items-center gap-2">
                          <input
                            type="time"
                            aria-label={`${period.name} shift ${j + 1} opens`}
                            value={r.start}
                            onChange={(e) => set((p) => void (p.hours[j]!.start = e.target.value))}
                            className="h-9 rounded-md border border-slate-300 bg-white px-2"
                          />
                          –
                          <input
                            type="time"
                            aria-label={`${period.name} shift ${j + 1} closes`}
                            value={r.end}
                            onChange={(e) => set((p) => void (p.hours[j]!.end = e.target.value))}
                            className="h-9 rounded-md border border-slate-300 bg-white px-2"
                          />
                          <button
                            type="button"
                            aria-label={`Remove shift ${j + 1}`}
                            onClick={() => set((p) => void p.hours.splice(j, 1))}
                            className="rounded px-1 text-slate-400 hover:text-slate-900"
                          >
                            ✕
                          </button>
                          {errorFor(`${path}.hours.${j}.end`) ? (
                            <span className="text-red-600">{errorFor(`${path}.hours.${j}.end`)}</span>
                          ) : null}
                        </span>
                      ))}
                      {period.hours.length < 4 ? (
                        <Button
                          variant="ghost"
                          className="h-8 px-2"
                          onClick={() => set((p) => void p.hours.push({ start: "09:00", end: "18:00" }))}
                        >
                          + Add shift
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="grid gap-4 md:grid-cols-[240px_1fr]">
              <SelectField
                label="Outside hours"
                value={wh.offHours}
                onChange={(e) =>
                  update((c) => void (c.workingHours!.offHours = e.target.value as typeof wh.offHours))
                }
              >
                <option value="normal">Answer normally</option>
                <option value="take_message">Say we're closed, then take details</option>
                <option value="closed_message">Say we're closed and hang up</option>
              </SelectField>
              <TextField
                label="Closed message"
                value={wh.offHoursMessage}
                error={errorFor("workingHours.offHoursMessage")}
                onChange={(e) => update((c) => void (c.workingHours!.offHoursMessage = e.target.value))}
              />
            </div>
          </div>
        ) : null}
      </Section>

      <Section
        title="Human handoff"
        description="When the caller asks for a person, or a workflow step transfers the call."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Check
            label="Allow transfers to a person"
            checked={config.handoff.enabled}
            onChange={(v) => update((c) => void (c.handoff.enabled = v))}
          />
          <TextField
            label="Transfer to (phone number)"
            placeholder="+911140000099"
            value={config.handoff.phoneNumber ?? ""}
            error={errorFor("handoff.phoneNumber")}
            onChange={(e) =>
              update((c) => void (c.handoff.phoneNumber = e.target.value.replace(/\s/g, "") || undefined))
            }
          />
          <TextField
            label="Before transferring, say"
            value={config.handoff.message}
            error={errorFor("handoff.message")}
            onChange={(e) => update((c) => void (c.handoff.message = e.target.value))}
          />
          <TextField
            label="When nobody is available, say"
            value={config.handoff.unavailableMessage}
            error={errorFor("handoff.unavailableMessage")}
            onChange={(e) => update((c) => void (c.handoff.unavailableMessage = e.target.value))}
          />
          <TextField
            key={config.handoff.notifyEmails.join(",")}
            label="Email staff when a transfer isn't answered"
            placeholder="frontdesk@example.com, owner@example.com"
            defaultValue={config.handoff.notifyEmails.join(", ")}
            error={errorFor("handoff.notifyEmails")}
            hint="Sent through your email integration. Up to 5, separated by commas."
            onBlur={(e) =>
              update((c) => void (c.handoff.notifyEmails = e.target.value.split(/[,;\s]+/).filter(Boolean)))
            }
          />
          <SelectField
            label="When the caller asks for a person"
            value={config.escalation.onWantsHuman}
            onChange={(e) =>
              update((c) => void (c.escalation.onWantsHuman = e.target.value as "handoff" | "take_message"))
            }
          >
            <option value="handoff">Transfer (during working hours)</option>
            <option value="take_message">Take a message</option>
          </SelectField>
        </div>
      </Section>

      <Section
        title="Bookings"
        description="Rules for appointments booked by the agent (platform calendar or Google Calendar)."
      >
        <div className="grid gap-4 md:grid-cols-3">
          {BOOKING_FIELDS.map(([key, label, hint]) => (
            <TextField
              key={key}
              label={label}
              hint={hint}
              type="number"
              min={key === "bufferMinutes" || key === "leadTimeMinutes" ? 0 : 1}
              value={(config.appointment ?? BOOKING_DEFAULTS)[key]}
              error={errorFor(`appointment.${key}`)}
              onChange={(e) =>
                update((c) => {
                  c.appointment = { ...(c.appointment ?? BOOKING_DEFAULTS), [key]: Number(e.target.value) };
                })
              }
            />
          ))}
        </div>
      </Section>

      <Section title="Escalation and limits">
        <div className="grid gap-4 md:grid-cols-3">
          <TextField
            label="Re-asks per question"
            type="number"
            min={0}
            max={5}
            value={config.escalation.maxReasksPerField}
            error={errorFor("escalation.maxReasksPerField")}
            onChange={(e) => update((c) => void (c.escalation.maxReasksPerField = Number(e.target.value)))}
          />
          <SelectField
            label="If a required answer can't be captured"
            value={config.escalation.onFieldFailure}
            onChange={(e) =>
              update((c) => void (c.escalation.onFieldFailure = e.target.value as "skip" | "handoff" | "end"))
            }
          >
            <option value="skip">Skip it and continue</option>
            <option value="handoff">Transfer to a person</option>
            <option value="end">End the call politely</option>
          </SelectField>
          <TextField
            label="Silent turns before hanging up"
            type="number"
            min={1}
            max={10}
            value={config.escalation.maxSilentTurns}
            error={errorFor("escalation.maxSilentTurns")}
            onChange={(e) => update((c) => void (c.escalation.maxSilentTurns = Number(e.target.value)))}
          />
          <TextField
            label="Maximum call length (seconds)"
            type="number"
            value={config.limits.maxDurationSeconds}
            error={errorFor("limits.maxDurationSeconds")}
            onChange={(e) => update((c) => void (c.limits.maxDurationSeconds = Number(e.target.value)))}
          />
          <TextField
            label="Maximum turns"
            type="number"
            value={config.limits.maxTurns}
            error={errorFor("limits.maxTurns")}
            onChange={(e) => update((c) => void (c.limits.maxTurns = Number(e.target.value)))}
          />
          <TextField
            label="AI failures before fixed wording"
            type="number"
            min={1}
            max={10}
            value={config.escalation.maxLlmFailures}
            error={errorFor("escalation.maxLlmFailures")}
            onChange={(e) => update((c) => void (c.escalation.maxLlmFailures = Number(e.target.value)))}
          />
        </div>
      </Section>

      <Section
        title="Fallback sentences"
        description="Exactly what the agent says in each situation when it can't rely on the AI."
        actions={
          <Button
            variant="secondary"
            className="h-9"
            onClick={() =>
              update((c) => {
                c.messages = config.language.startsWith("ar")
                  ? { ...ARABIC_MESSAGES }
                  : FallbackMessages.parse({});
              })
            }
          >
            {config.language.startsWith("ar") ? "Use Arabic wording" : "Use default wording"}
          </Button>
        }
      >
        <div className="grid gap-4 md:grid-cols-2">
          {(Object.keys(MESSAGE_LABELS) as (keyof AgentConfig["messages"])[]).map((k) => (
            <TextField
              key={k}
              label={MESSAGE_LABELS[k]}
              value={config.messages[k]}
              error={errorFor(`messages.${k}`)}
              onChange={(e) => update((c) => void (c.messages[k] = e.target.value))}
            />
          ))}
        </div>
      </Section>
    </div>
  );
}
