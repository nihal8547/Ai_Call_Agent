"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useCan, useMe } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { TextArea } from "@/components/ui/inputs";
import { Alert } from "@/components/ui/misc";
import { StatusPill } from "@/components/ui/status-pill";
import { api } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import type { Appointment } from "@/lib/types";
import { localDate, localTime } from "@/lib/tz";

export function AppointmentDetail({
  appointment: a,
  onChanged,
}: {
  appointment: Appointment;
  onChanged: (a: Appointment) => void;
}) {
  const me = useMe();
  const qc = useQueryClient();
  const canWrite = useCan("appointments:write");
  const tz = a.timezone;
  const start = new Date(a.startsAt);
  const [moving, setMoving] = useState(false);
  const [date, setDate] = useState(localDate(start, tz));
  const [time, setTime] = useState(localTime(start, tz));
  const [notes, setNotes] = useState(a.notes ?? "");

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<Appointment>(`/appointments/${a.id}`, { method: "PATCH", body }),
    onSuccess: async (next) => {
      setMoving(false);
      onChanged(next);
      await qc.invalidateQueries({ queryKey: ["appointments"] });
    },
  });
  const fieldError = (p: string) =>
    patch.error instanceof ApiError
      ? patch.error.fieldErrors.find((e) => e.path.startsWith(p))?.message
      : undefined;
  const when = new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: tz,
  }).format(start);
  const minutes = Math.round((new Date(a.endsAt).getTime() - start.getTime()) / 60000);
  const upcoming = a.status === "UPCOMING";

  return (
    <div className="space-y-4 text-sm">
      {patch.error && !fieldError("reschedule") ? <Alert>{errorMessage(patch.error)}</Alert> : null}
      <div className="flex items-center gap-2">
        <StatusPill value={a.status} />
        {a.integration ? <span className="text-slate-500">Synced to {a.integration.name}</span> : null}
      </div>
      <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2">
        <dt className="text-slate-500">When</dt>
        <dd>
          {when} · {minutes} min
        </dd>
        <dt className="text-slate-500">Who</dt>
        <dd>
          {a.lead?.customerName ?? "Unknown caller"}
          {a.lead?.phone ? <span className="text-slate-500"> · {a.lead.phone}</span> : null}
        </dd>
        <dt className="text-slate-500">Booked by</dt>
        <dd>{a.agent?.name ?? "Your team"}</dd>
        {a.callId ? (
          <>
            <dt className="text-slate-500">Call</dt>
            <dd>
              <Link href={`/t/${me.tenant.slug}/calls/${a.callId}`} className="underline">
                Open the call
              </Link>
            </dd>
          </>
        ) : null}
      </dl>

      {canWrite ? (
        <>
          {moving ? (
            <form
              className="grid gap-3 rounded-xl border border-slate-200 p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end dark:border-slate-700"
              onSubmit={(e) => {
                e.preventDefault();
                patch.mutate({ reschedule: { date, time } });
              }}
            >
              <TextField
                label="New date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                error={fieldError("reschedule.date")}
              />
              <TextField
                label="New time"
                type="time"
                step={300}
                value={time}
                onChange={(e) => setTime(e.target.value)}
                error={fieldError("reschedule")}
              />
              <Button type="submit" loading={patch.isPending}>
                Move
              </Button>
            </form>
          ) : null}
          <TextArea label="Notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={notes === (a.notes ?? "")}
              loading={patch.isPending}
              onClick={() => patch.mutate({ notes: notes.trim() || null })}
            >
              Save notes
            </Button>
            {upcoming ? (
              <>
                <Button variant="secondary" onClick={() => setMoving((m) => !m)}>
                  Reschedule
                </Button>
                <Button variant="secondary" onClick={() => patch.mutate({ status: "COMPLETED" })}>
                  Mark attended
                </Button>
                <Button variant="secondary" onClick={() => patch.mutate({ status: "NO_SHOW" })}>
                  No-show
                </Button>
                <Button
                  variant="danger"
                  onClick={() =>
                    confirm(
                      a.integration
                        ? "Cancel this appointment? It is also removed from the calendar."
                        : "Cancel this appointment?",
                    ) && patch.mutate({ status: "CANCELLED" })
                  }
                >
                  Cancel appointment
                </Button>
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
