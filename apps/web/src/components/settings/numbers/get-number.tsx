"use client";

import { COUNTRIES, TWILIO_NUMBER_TYPES } from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useCan, useMe } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Alert, Card } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import type { AvailableNumber } from "@/lib/types";
import { useAgents, useNumbers } from "./hooks";

const TYPE_LABELS: Record<(typeof TWILIO_NUMBER_TYPES)[number], string> = {
  local: "Local",
  mobile: "Mobile",
  toll_free: "Toll-free",
};

/** A number and label for it, and the agent that answers */
function AgentAndLabel({
  agentId,
  setAgentId,
  label,
  setLabel,
}: {
  agentId: string;
  setAgentId: (v: string) => void;
  label: string;
  setLabel: (v: string) => void;
}) {
  const agents = useAgents();
  return (
    <>
      <TextField
        label="Label"
        placeholder="Front desk"
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
    </>
  );
}

export function GetNumber({ onDone }: { onDone: () => void }) {
  const numbers = useNumbers();
  if (!numbers.data) return null;
  return numbers.data.twilioAccount ? <BuyNumber onDone={onDone} /> : <ManualNumber onDone={onDone} />;
}

function BuyNumber({ onDone }: { onDone: () => void }) {
  const me = useMe();
  const canBuy = useCan("billing:write");
  const qc = useQueryClient();
  const [country, setCountry] = useState<string>(me.tenant.country);
  const [type, setType] = useState<(typeof TWILIO_NUMBER_TYPES)[number]>("local");
  const [contains, setContains] = useState("");
  const [search, setSearch] = useState<{ country: string; type: string; contains: string } | null>(null);
  const [agentId, setAgentId] = useState("");
  const [label, setLabel] = useState("");

  const results = useQuery({
    queryKey: ["twilio-available", search],
    queryFn: () => {
      const q = new URLSearchParams({ country: search!.country, type: search!.type });
      if (search!.contains) q.set("contains", search!.contains);
      return api<{ items: AvailableNumber[] }>(`/phone-numbers/twilio/available?${q}`);
    },
    enabled: Boolean(search),
    retry: false,
  });
  const buy = useMutation({
    mutationFn: (phoneNumber: string) =>
      api("/phone-numbers/twilio/buy", {
        method: "POST",
        body: {
          phoneNumber,
          agentId: agentId || null,
          ...(label.trim() ? { friendlyName: label.trim() } : {}),
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["phone-numbers"] });
      onDone();
    },
  });

  return (
    <Card>
      <h3 className="font-semibold">Find a number</h3>
      <form
        className="mt-4 grid gap-4 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch({ country, type, contains: contains.replace(/\D/g, "") });
        }}
      >
        <SelectField label="Country" value={country} onChange={(e) => setCountry(e.target.value)}>
          {Object.entries(COUNTRIES).map(([code, c]) => (
            <option key={code} value={code}>
              {c.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Type"
          value={type}
          onChange={(e) => setType(e.target.value as (typeof TWILIO_NUMBER_TYPES)[number])}
        >
          {TWILIO_NUMBER_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Contains digits (optional)"
          inputMode="numeric"
          placeholder="e.g. 4412"
          value={contains}
          onChange={(e) => setContains(e.target.value)}
        />
        <Button type="submit" loading={results.isFetching}>
          Search
        </Button>
      </form>

      {results.error ? (
        <div className="mt-4">
          <Alert>{errorMessage(results.error)}</Alert>
        </div>
      ) : null}
      {results.data && !results.data.items.length ? (
        <div className="mt-4">
          <Alert tone="info">
            No {TYPE_LABELS[type].toLowerCase()} numbers are available there right now. Try another type or
            remove the digits.
            {country === "QA" ? (
              <span className="mt-1 block">
                Twilio has few or no Qatar numbers. To keep a Qatar number for customers, forward your
                existing Ooredoo or Vodafone number to a number from another country (your carrier charges its
                international rate for forwarded calls), or connect your line over SIP.
              </span>
            ) : null}
          </Alert>
        </div>
      ) : null}

      {results.data?.items.length ? (
        <div className="mt-6 space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <AgentAndLabel agentId={agentId} setAgentId={setAgentId} label={label} setLabel={setLabel} />
          </div>
          {!canBuy ? (
            <Alert tone="info">Buying a number needs billing access. Ask the business owner.</Alert>
          ) : null}
          {buy.error ? <Alert>{errorMessage(buy.error)}</Alert> : null}
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {results.data.items.map((n) => (
              <li key={n.phoneNumber} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-48 flex-1">
                  <p className="font-medium tabular-nums">{n.friendlyName}</p>
                  <p className="text-slate-500">
                    {[n.locality, n.region, n.isoCountry].filter(Boolean).join(", ")}
                    {n.addressRequirements !== "none" ? " · needs a registered address" : ""}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  className="h-9"
                  disabled={!canBuy || buy.isPending}
                  loading={buy.isPending && buy.variables === n.phoneNumber}
                  onClick={() =>
                    confirm(`Buy ${n.friendlyName}? It is billed every month until you release it.`) &&
                    buy.mutate(n.phoneNumber)
                  }
                >
                  Buy
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

/** Without the platform's Twilio account: add a Twilio number already pointed at this platform */
function ManualNumber({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [e164, setE164] = useState("");
  const [agentId, setAgentId] = useState("");
  const [label, setLabel] = useState("");
  const add = useMutation({
    mutationFn: () =>
      api("/phone-numbers", {
        method: "POST",
        body: {
          e164: e164.replace(/[\s()-]/g, ""),
          ...(label.trim() ? { friendlyName: label.trim() } : {}),
          agentId: agentId || null,
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["phone-numbers"] });
      onDone();
    },
  });
  return (
    <Card>
      <h3 className="font-semibold">Add a Twilio number</h3>
      <p className="mt-1 text-sm text-slate-500">
        Buying numbers here needs the platform's Twilio account, which isn't connected. Add a Twilio number
        whose voice webhook already points at this platform.
      </p>
      {add.error ? (
        <div className="mt-4">
          <Alert>{errorMessage(add.error)}</Alert>
        </div>
      ) : null}
      <form
        className="mt-4 grid gap-4 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <TextField
          label="Number"
          placeholder="+44 20 7946 0000"
          inputMode="tel"
          value={e164}
          onChange={(e) => setE164(e.target.value)}
          hint="International format with country code"
        />
        <AgentAndLabel agentId={agentId} setAgentId={setAgentId} label={label} setLabel={setLabel} />
        <Button type="submit" loading={add.isPending} disabled={!e164.trim()}>
          Add
        </Button>
      </form>
    </Card>
  );
}
