"use client";

import { CARRIER_KEYS, FORWARDING_MODE_KEYS } from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useMe } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField, TextField } from "@/components/ui/field";
import { Alert, Card } from "@/components/ui/misc";
import { StatusPill } from "@/components/ui/status-pill";
import { api } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { fmtDateTime } from "@/lib/format";
import type { ForwardingInstructions, PhoneNumber, VerificationStatus } from "@/lib/types";
import { useNumbers } from "./hooks";

type Carrier = (typeof CARRIER_KEYS)[number];
type Mode = (typeof FORWARDING_MODE_KEYS)[number];

export const CARRIER_NAMES: Record<Carrier, string> = {
  ooredoo: "Ooredoo",
  vodafone_qa: "Vodafone Qatar",
  other: "Another carrier",
};
const MODE_LABELS: Record<Mode, string> = {
  NO_ANSWER_BUSY_UNREACHABLE: "Only when we can't answer (no answer, busy or phone off)",
  ALL: "Every call goes to the agent",
};
export const VERIFICATION_LABELS: Record<VerificationStatus, string> = {
  NONE: "Not tested",
  PENDING: "Waiting for test call",
  VERIFIED: "Connected",
  FAILED: "Test call not received",
};

/** A local example in the business's own country, so people type what they know */
function examplePhone(callingCode: string): string {
  if (callingCode === "974") return "+974 5512 3456";
  if (callingCode === "91") return "+91 98765 43210";
  if (callingCode === "971") return "+971 50 123 4567";
  return `+${callingCode} …`;
}

type Connected = { number: PhoneNumber; instructions: ForwardingInstructions };

// ── Step 1: which line, which carrier, which Twilio number it forwards to ─────
function ConnectForm({ target, onConnected }: { target?: PhoneNumber; onConnected: (r: Connected) => void }) {
  const me = useMe();
  const numbers = useNumbers();
  const qc = useQueryClient();
  const free = (numbers.data?.items ?? []).filter((n) => n.provider === "TWILIO" && !n.forwardedFrom);
  const [numberId, setNumberId] = useState(target?.id ?? "");
  const [businessNumber, setBusinessNumber] = useState("");
  const [carrier, setCarrier] = useState<Carrier>(me.tenant.country === "QA" ? "ooredoo" : "other");
  const [mode, setMode] = useState<Mode>("NO_ANSWER_BUSY_UNREACHABLE");
  const chosen = numberId || free[0]?.id || "";

  const connect = useMutation({
    mutationFn: () =>
      api<Connected>(`/phone-numbers/${chosen}/forwarding`, {
        method: "POST",
        body: { businessNumber, carrier, mode },
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["phone-numbers"] });
      onConnected(r);
    },
  });
  const fieldError = (path: string) =>
    connect.error instanceof ApiError
      ? connect.error.fieldErrors.find((f) => f.path === path)?.message
      : undefined;

  return (
    <form
      className="grid gap-4 md:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        connect.mutate();
      }}
    >
      {connect.error && !fieldError("businessNumber") ? (
        <div className="md:col-span-2">
          <Alert>{errorMessage(connect.error)}</Alert>
        </div>
      ) : null}
      <TextField
        label="The number customers call now"
        placeholder={examplePhone(me.tenant.callingCode)}
        inputMode="tel"
        autoComplete="off"
        value={businessNumber}
        onChange={(e) => setBusinessNumber(e.target.value)}
        error={fieldError("businessNumber")}
        hint="Your business mobile or landline. Local digits are fine."
      />
      <SelectField label="Carrier" value={carrier} onChange={(e) => setCarrier(e.target.value as Carrier)}>
        {CARRIER_KEYS.map((c) => (
          <option key={c} value={c}>
            {CARRIER_NAMES[c]}
          </option>
        ))}
      </SelectField>
      <SelectField
        label="Send calls to the agent"
        value={mode}
        onChange={(e) => setMode(e.target.value as Mode)}
      >
        {FORWARDING_MODE_KEYS.map((m) => (
          <option key={m} value={m}>
            {MODE_LABELS[m]}
          </option>
        ))}
      </SelectField>
      {target ? null : (
        <SelectField
          label="Forward to"
          value={chosen}
          onChange={(e) => setNumberId(e.target.value)}
          hint="The agent's number. Customers never see it."
        >
          {free.map((n) => (
            <option key={n.id} value={n.id}>
              {n.e164}
              {n.agent ? ` · ${n.agent.name}` : " · no agent yet"}
            </option>
          ))}
        </SelectField>
      )}
      <div className="md:col-span-2">
        <Button type="submit" loading={connect.isPending} disabled={!businessNumber.trim() || !chosen}>
          Continue
        </Button>
      </div>
    </form>
  );
}

// ── Step 2: the codes to dial ─────────────────────────────────────────────────
export function Instructions({ instructions }: { instructions: ForwardingInstructions }) {
  return (
    <div className="space-y-4 text-sm">
      <div>
        <h4 className="font-medium">On a mobile line</h4>
        <p className="text-slate-500">{instructions.mobile.note}</p>
        <ol className="mt-2 space-y-2">
          {instructions.mobile.enable.map((s) => (
            <li
              key={s.code}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
            >
              <span className="min-w-48 flex-1">{s.label}</span>
              <code className="rounded bg-slate-100 px-2 py-1 font-mono tabular-nums dark:bg-slate-800">
                {s.code}
              </code>
              <CopyButton text={s.code ?? ""} />
              {/* On a phone this opens the dialler with the code filled in */}
              <a
                href={`tel:${encodeURIComponent(s.code ?? "")}`}
                className="text-sm font-medium text-brand-600 hover:underline"
              >
                Dial
              </a>
            </li>
          ))}
        </ol>
        <p className="mt-2 text-xs text-slate-500">
          To stop later, dial{" "}
          {instructions.mobile.disable.map((s) => (
            <code key={s.code} className="font-mono">
              {s.code}
            </code>
          ))}
          .
        </p>
      </div>
      <div>
        <h4 className="font-medium">On a landline or office phone system</h4>
        <p className="text-slate-500">{instructions.landline}</p>
      </div>
      <p className="text-xs text-slate-500">{instructions.costs}</p>
    </div>
  );
}

// ── Step 3: a test call proves the route ──────────────────────────────────────
export function VerifyPanel({ number }: { number: PhoneNumber }) {
  const qc = useQueryClient();
  const [from, setFrom] = useState("");
  const start = useMutation({
    mutationFn: () =>
      api<PhoneNumber>(`/phone-numbers/${number.id}/verify`, {
        method: "POST",
        body: from.trim() ? { from: from.trim() } : {},
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["phone-numbers"] }),
  });
  const status = number.verificationStatus;
  const v = number.verification;

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium">Status</span>
        <StatusPill value={status} label={VERIFICATION_LABELS[status]} />
      </div>
      {status === "PENDING" ? (
        <Alert tone="info">
          From another phone, call <strong className="tabular-nums">{number.forwardedFrom}</strong>
          {v.expectFrom ? (
            <>
              {" "}
              (from <span className="tabular-nums">{v.expectFrom}</span>)
            </>
          ) : null}
          .{" "}
          {number.forwardingMode === "ALL"
            ? "It goes straight to the agent."
            : "Don't pick up on the business phone: after about 20 seconds the call moves to the agent."}{" "}
          You'll hear “Your number is connected”. Waiting until {fmtDateTime(number.verificationExpiresAt)}.
        </Alert>
      ) : status === "VERIFIED" ? (
        <Alert tone="success">
          Test call received {fmtDateTime(number.verifiedAt)}
          {v.from ? (
            <>
              {" "}
              from <span className="tabular-nums">{v.from}</span>
            </>
          ) : null}
          . Calls to {number.forwardedFrom} now reach your agent.
          {v.callerIdKept === false ? (
            <span className="mt-1 block">
              Your carrier showed your own number instead of the caller's, so leads won't have the customer's
              number. Ask your carrier to keep the original caller ID on forwarded calls.
            </span>
          ) : null}
        </Alert>
      ) : status === "FAILED" ? (
        <Alert>
          No test call arrived within 10 minutes. Check that each code was confirmed on the phone (some
          business plans need forwarding switched on by the carrier), then try again.
        </Alert>
      ) : null}
      {status !== "PENDING" ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            start.mutate();
          }}
        >
          <TextField
            label="I'll call from (optional)"
            placeholder="Your personal mobile"
            inputMode="tel"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            hint="Only a call from this phone counts as the test"
          />
          <Button
            type="submit"
            variant={status === "VERIFIED" ? "secondary" : "primary"}
            loading={start.isPending}
          >
            {status === "VERIFIED" ? "Test again" : "Start test call"}
          </Button>
        </form>
      ) : null}
      {start.error ? <Alert>{errorMessage(start.error)}</Alert> : null}
    </div>
  );
}

// ── The whole flow, from the "Use my existing number" option ─────────────────
export function ExistingNumberWizard({
  onGetNumber,
  onDone,
}: {
  onGetNumber: () => void;
  onDone: () => void;
}) {
  const numbers = useNumbers();
  const [connected, setConnected] = useState<Connected | null>(null);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const live = numbers.data?.items.find((n) => n.id === connected?.number.id) ?? connected?.number;
  const free = (numbers.data?.items ?? []).filter((n) => n.provider === "TWILIO" && !n.forwardedFrom);

  const steps = ["Your number", "Turn on forwarding", "Test call"];
  return (
    <Card>
      <ol className="mb-6 flex flex-wrap gap-4 text-sm" aria-label="Steps">
        {steps.map((label, i) => (
          <li
            key={label}
            aria-current={step === i + 1 ? "step" : undefined}
            className={step === i + 1 ? "font-semibold text-brand-600" : "text-slate-500"}
          >
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      {step === 1 ? (
        numbers.data && !free.length ? (
          <div className="space-y-3 text-sm">
            <p>
              Your existing number forwards calls to an agent number. You don't have a free one yet: get one
              first (it's never shown to customers).
            </p>
            <p className="text-slate-500">
              With a business SIP line or office phone system you can connect over SIP instead, with no
              forwarding.
            </p>
            <Button onClick={onGetNumber}>Get an agent number</Button>
          </div>
        ) : (
          <ConnectForm
            onConnected={(r) => {
              setConnected(r);
              setStep(2);
            }}
          />
        )
      ) : null}

      {step === 2 && connected ? (
        <div className="space-y-4">
          <p className="text-sm">
            Calls to <strong className="tabular-nums">{connected.number.forwardedFrom}</strong> will forward
            to <strong className="tabular-nums">{connected.instructions.target}</strong>, where your agent
            answers.
          </p>
          <Instructions instructions={connected.instructions} />
          <Button onClick={() => setStep(3)}>I've turned it on</Button>
        </div>
      ) : null}

      {step === 3 && live ? (
        <div className="space-y-4">
          <VerifyPanel number={live} />
          <div className="flex gap-3">
            <Button variant="secondary" onClick={() => setStep(2)}>
              Back to the codes
            </Button>
            <Button variant={live.verificationStatus === "VERIFIED" ? "primary" : "ghost"} onClick={onDone}>
              {live.verificationStatus === "VERIFIED" ? "Done" : "Finish later"}
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

// ── Manage forwarding for one number, from the list ───────────────────────────
export function ForwardingDialog({ number, onClose }: { number: PhoneNumber | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [justConnected, setJustConnected] = useState<ForwardingInstructions | null>(null);
  const [disableCode, setDisableCode] = useState<string | null>(null);
  const instructions = useQuery({
    queryKey: ["forwarding", number?.id, number?.forwardedFrom, number?.forwardingMode],
    queryFn: () => api<ForwardingInstructions>(`/phone-numbers/${number!.id}/forwarding`),
    enabled: Boolean(number?.forwardedFrom) && !justConnected,
  });
  const disconnect = useMutation({
    mutationFn: () =>
      api<{ disable: string }>(`/phone-numbers/${number!.id}/forwarding`, { method: "DELETE" }),
    onSuccess: (r) => {
      setDisableCode(r.disable);
      void qc.invalidateQueries({ queryKey: ["phone-numbers"] });
    },
  });
  const close = () => {
    setJustConnected(null);
    setDisableCode(null);
    onClose();
  };
  const shown = justConnected ?? instructions.data;

  return (
    <Dialog
      open={Boolean(number)}
      onClose={close}
      title={number ? `Forwarding to ${number.e164}` : "Forwarding"}
    >
      {!number ? null : disableCode ? (
        <div className="space-y-3 text-sm">
          <Alert tone="success">
            Disconnected. Calls to your number won't be answered by the agent any more.
          </Alert>
          <p>
            Also turn forwarding off on the phone: dial <code className="font-mono">{disableCode}</code>{" "}
            <CopyButton text={disableCode} />
          </p>
        </div>
      ) : !number.forwardedFrom ? (
        <ConnectForm target={number} onConnected={(r) => setJustConnected(r.instructions)} />
      ) : (
        <div className="space-y-6">
          <p className="text-sm">
            Customers call <strong className="tabular-nums">{number.forwardedFrom}</strong>
            {number.carrier ? ` (${CARRIER_NAMES[number.carrier]})` : ""}.
          </p>
          {shown ? <Instructions instructions={shown} /> : <p className="text-sm text-slate-500">Loading…</p>}
          <hr className="border-slate-200 dark:border-slate-800" />
          <VerifyPanel number={number} />
          <hr className="border-slate-200 dark:border-slate-800" />
          <Button
            variant="ghost"
            className="text-red-600"
            loading={disconnect.isPending}
            onClick={() =>
              confirm(`Stop answering calls forwarded from ${number.forwardedFrom}?`) && disconnect.mutate()
            }
          >
            Disconnect my number
          </Button>
          {disconnect.error ? <Alert>{errorMessage(disconnect.error)}</Alert> : null}
        </div>
      )}
    </Dialog>
  );
}
