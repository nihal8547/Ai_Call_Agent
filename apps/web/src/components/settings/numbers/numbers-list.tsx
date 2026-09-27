"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useCan } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { Alert, Badge } from "@/components/ui/misc";
import { Section } from "@/components/ui/inputs";
import { StatusPill } from "@/components/ui/status-pill";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { fmtDateTime } from "@/lib/format";
import type { PhoneNumber } from "@/lib/types";
import { useAgents, useNumbers } from "./hooks";
import { CARRIER_NAMES, ForwardingDialog, VERIFICATION_LABELS } from "./existing-number";

const control =
  "h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900";

export function NumbersList() {
  const numbers = useNumbers();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["phone-numbers"] });
  const [open, setOpen] = useState<string | null>(null);

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api(`/phone-numbers/${id}`, { method: "PATCH", body }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: ({ id, release }: { id: string; release: boolean }) =>
      api(`/phone-numbers/${id}${release ? "?release=1" : ""}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  const error = patch.error ?? remove.error;
  const items = numbers.data?.items ?? [];
  const current = items.find((n) => n.id === open) ?? null;

  return (
    <Section title="Your numbers" description="Each number is answered by the agent you choose.">
      {error ? (
        <div className="mb-4">
          <Alert>{errorMessage(error)}</Alert>
        </div>
      ) : null}
      {numbers.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {numbers.data && !items.length ? (
        <p className="text-sm text-slate-500">No numbers yet. Choose how customers will call you above.</p>
      ) : null}
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {items.map((n) => (
          <NumberRow
            key={n.id}
            n={n}
            twilioAccount={Boolean(numbers.data?.twilioAccount)}
            onPatch={(body) => patch.mutate({ id: n.id, body })}
            onRemove={(release) => remove.mutate({ id: n.id, release })}
            onForwarding={() => setOpen(n.id)}
          />
        ))}
      </ul>
      <ForwardingDialog number={current} onClose={() => setOpen(null)} />
    </Section>
  );
}

function NumberRow({
  n,
  twilioAccount,
  onPatch,
  onRemove,
  onForwarding,
}: {
  n: PhoneNumber;
  twilioAccount: boolean;
  onPatch: (body: Record<string, unknown>) => void;
  onRemove: (release: boolean) => void;
  onForwarding: () => void;
}) {
  const canWrite = useCan("phone_numbers:write");
  const agents = useAgents();
  const [limit, setLimit] = useState(n.maxConcurrentCalls?.toString() ?? "");

  const saveLimit = () => {
    const value = limit.trim() ? Number(limit) : null;
    if (value === n.maxConcurrentCalls) return;
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 500)) {
      setLimit(n.maxConcurrentCalls?.toString() ?? "");
      return;
    }
    onPatch({ maxConcurrentCalls: value });
  };

  const removeNumber = () => {
    if (!confirm(`Remove ${n.e164}? Calls to it will no longer reach your agents.`)) return;
    // A number bought here keeps costing money until it is released back to Twilio
    const release =
      n.provider === "TWILIO" && Boolean(n.providerSid) && twilioAccount
        ? confirm(
            "Also release the number back to Twilio so it stops costing money? You can't get it back afterwards.",
          )
        : false;
    onRemove(release);
  };

  return (
    <li className="flex flex-col gap-3 py-4 text-sm lg:flex-row lg:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium tabular-nums">{n.e164}</p>
          <Badge>{n.provider === "SIP" ? `SIP · ${n.sipTrunk?.name ?? "connection"}` : "Twilio"}</Badge>
          {!n.isActive ? <StatusPill value="INACTIVE" label="Paused" /> : null}
        </div>
        <p className="text-slate-500">{n.friendlyName ?? "No label"}</p>
        {n.forwardedFrom ? (
          <p className="mt-1 flex flex-wrap items-center gap-2">
            <span>
              Customers call <span className="font-medium tabular-nums">{n.forwardedFrom}</span>
              {n.carrier ? ` (${CARRIER_NAMES[n.carrier]})` : ""}, forwarded here
            </span>
            <StatusPill value={n.verificationStatus} label={VERIFICATION_LABELS[n.verificationStatus]} />
          </p>
        ) : null}
        {n.lastCallAt ? (
          <p className="text-xs text-slate-500">Last call {fmtDateTime(n.lastCallAt)}</p>
        ) : null}
      </div>

      {canWrite ? (
        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label={`Agent for ${n.e164}`}
            value={n.agent?.id ?? ""}
            onChange={(e) => onPatch({ agentId: e.target.value || null })}
            className={control}
          >
            <option value="">No agent</option>
            {agents.data?.items.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2">
            <span className="text-slate-500">Max calls</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={500}
              placeholder="No limit"
              aria-label={`Simultaneous calls allowed on ${n.e164}`}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              onBlur={saveLimit}
              className={`${control} w-24`}
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={n.isActive}
              onChange={(e) => onPatch({ isActive: e.target.checked })}
            />
            Active
          </label>
          {n.provider === "TWILIO" ? (
            <Button variant="secondary" className="h-9" onClick={onForwarding}>
              {n.forwardedFrom ? "Forwarding" : "Forward my number here"}
            </Button>
          ) : null}
          <Button variant="ghost" className="h-9 text-red-600" onClick={removeNumber}>
            Remove
          </Button>
        </div>
      ) : (
        <span className="text-slate-500">{n.agent?.name ?? "No agent"}</span>
      )}
    </li>
  );
}
