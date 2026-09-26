"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useCan } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField, TextField } from "@/components/ui/field";
import { Alert, Card, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import type { LeadStatus } from "@/lib/types";

/** "Site visit booked" → "site_visit_booked" */
const keyFrom = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "s_$1")
    .slice(0, 40);

/** The columns of the lead pipeline: order, colour, default for new leads, and closed stages */
export function LeadStatusesPage() {
  const canWrite = useCan("leads:write");
  const qc = useQueryClient();
  const statuses = useQuery({
    queryKey: ["lead-statuses"],
    queryFn: () => api<{ items: LeadStatus[] }>("/lead-statuses"),
  });
  const [label, setLabel] = useState("");
  const [removing, setRemoving] = useState<LeadStatus | null>(null);
  const [moveTo, setMoveTo] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["lead-statuses"] });
  const items = [...(statuses.data?.items ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api(`/lead-statuses/${id}`, { method: "PATCH", body }),
    onSuccess: refresh,
  });
  const create = useMutation({
    mutationFn: () =>
      api("/lead-statuses", {
        method: "POST",
        body: { key: keyFrom(label), label: label.trim(), sortOrder: (items.at(-1)?.sortOrder ?? 0) + 10 },
      }),
    onSuccess: () => {
      setLabel("");
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (s: LeadStatus) =>
      api(`/lead-statuses/${s.id}${moveTo ? `?moveTo=${moveTo}` : ""}`, { method: "DELETE" }),
    onSuccess: () => {
      setRemoving(null);
      setMoveTo("");
      void refresh();
      void qc.invalidateQueries({ queryKey: ["leads"] });
    },
  });
  /** Swap positions with a neighbour (sort orders are renumbered so ties can't stick) */
  const move = async (index: number, delta: number) => {
    const next = [...items];
    const [s] = next.splice(index, 1);
    next.splice(index + delta, 0, s!);
    await Promise.all(
      next.map((x, i) =>
        (i + 1) * 10 !== x.sortOrder
          ? api(`/lead-statuses/${x.id}`, { method: "PATCH", body: { sortOrder: (i + 1) * 10 } })
          : null,
      ),
    );
    await refresh();
  };
  const error = patch.error ?? create.error;

  return (
    <>
      <PageHeader
        title="Lead statuses"
        description="The stages of your pipeline, shown as columns on the leads board."
      />
      {error ? (
        <div className="mb-4">
          <Alert>{errorMessage(error)}</Alert>
        </div>
      ) : null}
      <Card className="p-0">
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {items.map((s, i) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              {canWrite ? (
                <>
                  <input
                    type="color"
                    aria-label={`Colour of ${s.label}`}
                    value={s.color}
                    onChange={(e) => patch.mutate({ id: s.id, body: { color: e.target.value } })}
                    className="size-8 cursor-pointer rounded border border-slate-300 bg-transparent dark:border-slate-700"
                  />
                  <input
                    key={s.label}
                    aria-label={`Name of ${s.label}`}
                    defaultValue={s.label}
                    onBlur={(e) =>
                      e.target.value.trim() &&
                      e.target.value.trim() !== s.label &&
                      patch.mutate({ id: s.id, body: { label: e.target.value.trim() } })
                    }
                    className="h-9 min-w-40 flex-1 rounded-lg border border-slate-300 bg-white px-2 dark:border-slate-700 dark:bg-slate-900"
                  />
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="default-status"
                      checked={s.isDefault}
                      onChange={() => patch.mutate({ id: s.id, body: { isDefault: true } })}
                    />
                    New leads
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={s.isTerminal}
                      onChange={(e) => patch.mutate({ id: s.id, body: { isTerminal: e.target.checked } })}
                    />
                    Closed stage
                  </label>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      className="h-8 px-2"
                      aria-label={`Move ${s.label} up`}
                      disabled={i === 0}
                      onClick={() => void move(i, -1)}
                    >
                      ↑
                    </Button>
                    <Button
                      variant="ghost"
                      className="h-8 px-2"
                      aria-label={`Move ${s.label} down`}
                      disabled={i === items.length - 1}
                      onClick={() => void move(i, 1)}
                    >
                      ↓
                    </Button>
                    <Button
                      variant="ghost"
                      className="h-8 px-2 text-red-600"
                      disabled={s.isDefault}
                      title={s.isDefault ? "Choose another status for new leads first" : undefined}
                      onClick={() => setRemoving(s)}
                    >
                      Delete
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <span className="size-3 rounded-full" style={{ background: s.color }} aria-hidden />
                  <span className="flex-1">{s.label}</span>
                  {s.isDefault ? <span className="text-slate-500">New leads</span> : null}
                  {s.isTerminal ? <span className="text-slate-500">Closed stage</span> : null}
                </>
              )}
            </li>
          ))}
        </ul>
      </Card>
      {canWrite ? (
        <Card className="mt-6">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <TextField
              label="New status"
              placeholder="e.g. Site visit booked"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="min-w-60 flex-1"
            />
            <Button type="submit" loading={create.isPending} disabled={keyFrom(label).length < 2}>
              Add
            </Button>
          </form>
        </Card>
      ) : null}
      <Dialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title={`Delete “${removing?.label ?? ""}”`}
      >
        {removing ? (
          <form
            className="space-y-4 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              remove.mutate(removing);
            }}
          >
            {remove.error ? <Alert>{errorMessage(remove.error)}</Alert> : null}
            <SelectField
              label="Move its leads to"
              value={moveTo}
              onChange={(e) => setMoveTo(e.target.value)}
              hint="Needed only if some leads have this status"
            >
              <option value="">Choose…</option>
              {items
                .filter((x) => x.id !== removing.id)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
            </SelectField>
            <div className="flex justify-end">
              <Button type="submit" variant="danger" loading={remove.isPending}>
                Delete status
              </Button>
            </div>
          </form>
        ) : null}
      </Dialog>
    </>
  );
}
