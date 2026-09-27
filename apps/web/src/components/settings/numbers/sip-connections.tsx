"use client";

import { SIP_CARRIER_KEYS } from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useCan, useMe } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField, TextField } from "@/components/ui/field";
import { Check, Section, TextArea } from "@/components/ui/inputs";
import { Alert, Card } from "@/components/ui/misc";
import { StatusPill } from "@/components/ui/status-pill";
import { api } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { fmtDateTime, plural } from "@/lib/format";
import type { SipSetupSheet, SipTrunk } from "@/lib/types";
import { useAgents, useNumbers } from "./hooks";

type SipCarrier = (typeof SIP_CARRIER_KEYS)[number];
const SIP_CARRIER_NAMES: Record<SipCarrier, string> = {
  ooredoo: "Ooredoo business SIP",
  vodafone_qa: "Vodafone Qatar business SIP",
  pbx: "Our office phone system (PBX)",
  other: "Another SIP provider",
};
const STATUS_LABELS: Record<SipTrunk["status"], string> = {
  PENDING_SETUP: "Waiting for setup",
  ACTIVE: "Ready",
  ERROR: "Setup failed",
  DISABLED: "Paused",
};

function useTrunks() {
  return useQuery({ queryKey: ["sip-trunks"], queryFn: () => api<{ items: SipTrunk[] }>("/sip-trunks") });
}

/** `listOnly`: the connections under the numbers list, without the form to add one */
export function SipConnections({ listOnly = false }: { listOnly?: boolean }) {
  const trunks = useTrunks();
  const items = trunks.data?.items ?? [];
  if (listOnly && !items.length) return null;
  return (
    <div className="mt-6 space-y-6">
      {listOnly ? null : <CreateTrunk />}
      {items.length ? (
        <Section
          title="SIP connections"
          description="Calls arrive from your carrier or phone system over SIP, with no forwarding."
        >
          <ul className="space-y-4">
            {items.map((t) => (
              <TrunkCard key={t.id} trunk={t} />
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

function CreateTrunk() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [carrier, setCarrier] = useState<SipCarrier>("ooredoo");
  const [ips, setIps] = useState("");
  const [useCredentials, setUseCredentials] = useState(false);
  const [created, setCreated] = useState<{ sipDomain: string; password?: string; username?: string } | null>(
    null,
  );

  const create = useMutation({
    mutationFn: () =>
      api<{ trunk: SipTrunk; sipDomain: string; password?: string }>("/sip-trunks", {
        method: "POST",
        body: { name, carrier, allowedIps: ips.split(/[\s,]+/).filter(Boolean), useCredentials },
      }),
    onSuccess: (r) => {
      setCreated({
        sipDomain: r.sipDomain,
        ...(r.password ? { password: r.password, username: r.trunk.authUsername ?? "" } : {}),
      });
      setName("");
      setIps("");
      void qc.invalidateQueries({ queryKey: ["sip-trunks"] });
    },
  });
  const fieldError = (path: string) =>
    create.error instanceof ApiError
      ? create.error.fieldErrors.find((f) => f.path === path)?.message
      : undefined;

  return (
    <Card>
      <h3 className="font-semibold">New SIP connection</h3>
      <p className="mt-1 text-sm text-slate-500">
        Ask your carrier (Ooredoo or Vodafone business support) or your PBX vendor for the public IP addresses
        their SIP calls come from. You get a SIP address and a setup sheet to send them.
      </p>
      {created ? (
        <div className="mt-4">
          <Alert tone="success">
            Created. Send calls to <code className="font-mono">{created.sipDomain}</code>.
            {created.password ? (
              <span className="mt-2 block">
                Username <code className="font-mono">{created.username}</code>, password (copy it now, it
                won't be shown again):
                <span className="mt-1 flex flex-wrap items-center gap-2">
                  <input
                    readOnly
                    value={created.password}
                    onFocus={(e) => e.currentTarget.select()}
                    aria-label="SIP password"
                    className="block min-w-0 flex-1 rounded border border-current/30 bg-transparent px-2 py-1 font-mono text-xs"
                  />
                  <CopyButton text={created.password} />
                </span>
              </span>
            ) : null}
          </Alert>
        </div>
      ) : null}
      {create.error && !fieldError("allowedIps") && !fieldError("name") ? (
        <div className="mt-4">
          <Alert>{errorMessage(create.error)}</Alert>
        </div>
      ) : null}
      <form
        className="mt-4 grid gap-4 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <TextField
          label="Name"
          placeholder="Main office line"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={fieldError("name")}
        />
        <SelectField
          label="Calls come from"
          value={carrier}
          onChange={(e) => setCarrier(e.target.value as SipCarrier)}
        >
          {SIP_CARRIER_KEYS.map((c) => (
            <option key={c} value={c}>
              {SIP_CARRIER_NAMES[c]}
            </option>
          ))}
        </SelectField>
        <TextArea
          className="md:col-span-2"
          label="Allowed IP addresses"
          rows={3}
          placeholder={"212.77.192.10\n212.77.193.0/24"}
          value={ips}
          onChange={(e) => setIps(e.target.value)}
          error={fieldError("allowedIps")}
          hint="One per line. Public IPv4 addresses or ranges (/16 or narrower). Only these can send calls."
        />
        <div className="md:col-span-2">
          <Check
            label="Also require a SIP username and password"
            hint="Recommended when the carrier's addresses change, or for a PBX on a home or office connection"
            checked={useCredentials}
            onChange={setUseCredentials}
          />
        </div>
        <div className="md:col-span-2">
          <Button type="submit" loading={create.isPending} disabled={name.trim().length < 2}>
            Create SIP connection
          </Button>
        </div>
      </form>
    </Card>
  );
}

function TrunkCard({ trunk }: { trunk: SipTrunk }) {
  const canWrite = useCan("phone_numbers:write");
  const numbers = useNumbers();
  const qc = useQueryClient();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["sip-trunks"] });
    void qc.invalidateQueries({ queryKey: ["phone-numbers"] });
  };
  const provision = useMutation({
    mutationFn: () => api(`/sip-trunks/${trunk.id}/provision`, { method: "POST" }),
    onSuccess: refresh,
  });
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/sip-trunks/${trunk.id}`, { method: "PATCH", body }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api(`/sip-trunks/${trunk.id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  const error = provision.error ?? patch.error ?? remove.error;
  const domain = `${trunk.domainName}.sip.twilio.com`;

  return (
    <li className="rounded-xl border border-slate-200 p-4 text-sm dark:border-slate-800">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{trunk.name}</p>
            <StatusPill value={trunk.status} label={STATUS_LABELS[trunk.status]} />
          </div>
          <p className="text-slate-500">{SIP_CARRIER_NAMES[trunk.carrier]}</p>
          <p className="mt-1 flex flex-wrap items-center gap-2">
            <code className="font-mono break-all">{domain}</code>
            <CopyButton text={domain} />
          </p>
          <p className="mt-1 text-slate-500">
            {trunk.allowedIps.length ? `From ${trunk.allowedIps.join(", ")}` : "Username and password only"}
            {trunk.authUsername ? " · with username and password" : ""} ·{" "}
            {plural(trunk._count.numbers, "number")}
            {trunk.lastCallAt ? ` · last call ${fmtDateTime(trunk.lastCallAt)}` : ""}
          </p>
          {trunk.status === "PENDING_SETUP" ? (
            <p className="mt-1 text-amber-700 dark:text-amber-300">
              The platform operator finishes this connection on the Twilio side; calls work once it shows
              Ready.
            </p>
          ) : null}
          {trunk.status === "ERROR" && trunk.lastError ? (
            <p className="mt-1 text-red-600">{trunk.lastError}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" className="h-9" onClick={() => setSheetOpen(true)}>
            Setup sheet
          </Button>
          {canWrite ? (
            <>
              <Button
                variant="secondary"
                className="h-9"
                onClick={() => setAdding((v) => !v)}
                aria-expanded={adding}
              >
                Add number
              </Button>
              {(trunk.status === "ERROR" || trunk.status === "PENDING_SETUP") &&
              numbers.data?.twilioAccount ? (
                <Button
                  variant="secondary"
                  className="h-9"
                  loading={provision.isPending}
                  onClick={() => provision.mutate()}
                >
                  Retry setup
                </Button>
              ) : null}
              {trunk.status === "ACTIVE" || trunk.status === "DISABLED" ? (
                <Button
                  variant="ghost"
                  className="h-9"
                  onClick={() =>
                    patch.mutate({ status: trunk.status === "DISABLED" ? "ACTIVE" : "DISABLED" })
                  }
                >
                  {trunk.status === "DISABLED" ? "Resume" : "Pause"}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                className="h-9 text-red-600"
                onClick={() => confirm(`Delete the SIP connection ${trunk.name}?`) && remove.mutate()}
              >
                Delete
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {error ? (
        <div className="mt-3">
          <Alert>{errorMessage(error)}</Alert>
        </div>
      ) : null}
      {adding ? <AddSipNumber trunkId={trunk.id} onDone={() => setAdding(false)} /> : null}
      <SetupSheetDialog trunk={trunk} open={sheetOpen} onClose={() => setSheetOpen(false)} />
    </li>
  );
}

function AddSipNumber({ trunkId, onDone }: { trunkId: string; onDone: () => void }) {
  const me = useMe();
  const agents = useAgents();
  const qc = useQueryClient();
  const [number, setNumber] = useState("");
  const [label, setLabel] = useState("");
  const [agentId, setAgentId] = useState("");
  const add = useMutation({
    mutationFn: () =>
      api(`/sip-trunks/${trunkId}/numbers`, {
        method: "POST",
        body: { number, agentId: agentId || null, ...(label.trim() ? { friendlyName: label.trim() } : {}) },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sip-trunks"] });
      void qc.invalidateQueries({ queryKey: ["phone-numbers"] });
      onDone();
    },
  });
  return (
    <form
      className="mt-4 grid gap-4 border-t border-slate-100 pt-4 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end dark:border-slate-800"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      {add.error ? (
        <div className="md:col-span-4">
          <Alert>{errorMessage(add.error)}</Alert>
        </div>
      ) : null}
      <TextField
        label="Number customers dial"
        placeholder={me.tenant.callingCode === "974" ? "+974 4412 3456" : `+${me.tenant.callingCode} …`}
        inputMode="tel"
        value={number}
        onChange={(e) => setNumber(e.target.value)}
      />
      <TextField
        label="Label"
        placeholder="Reception"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <SelectField label="Answered by" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
        <option value="">No agent yet</option>
        {agents.data?.items.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </SelectField>
      <Button type="submit" loading={add.isPending} disabled={!number.trim()}>
        Add
      </Button>
    </form>
  );
}

function SetupSheetDialog({ trunk, open, onClose }: { trunk: SipTrunk; open: boolean; onClose: () => void }) {
  const sheet = useQuery({
    queryKey: ["sip-sheet", trunk.id, trunk._count.numbers, trunk.status],
    queryFn: () => api<SipSetupSheet>(`/sip-trunks/${trunk.id}/setup-sheet`),
    enabled: open,
  });
  const download = () => {
    if (!sheet.data) return;
    const url = URL.createObjectURL(new Blob([sheet.data.text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `sip-setup-${trunk.domainName}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Dialog open={open} onClose={onClose} title={`Setup sheet: ${trunk.name}`}>
      <p className="mb-3 text-sm text-slate-500">Send this to your carrier or PBX vendor.</p>
      {sheet.error ? <Alert>{errorMessage(sheet.error)}</Alert> : null}
      {sheet.data ? (
        <>
          <pre className="overflow-x-auto rounded-lg bg-slate-100 p-3 text-xs whitespace-pre-wrap dark:bg-slate-800">
            {sheet.data.text}
          </pre>
          <div className="mt-4 flex gap-2">
            <CopyButton text={sheet.data.text} label="Copy all" className="h-9 px-4" />
            <Button variant="secondary" className="h-9" onClick={download}>
              Download
            </Button>
          </div>
        </>
      ) : (
        <p className="text-sm text-slate-500">Loading…</p>
      )}
    </Dialog>
  );
}
