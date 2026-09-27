"use client";

import { useState } from "react";
import { useCan } from "@/components/app/me-context";
import { PageHeader } from "@/components/ui/misc";
import { cn } from "@/lib/cn";
import { BlockedCallers } from "./numbers/blocked-callers";
import { GetNumber } from "./numbers/get-number";
import { ExistingNumberWizard } from "./numbers/existing-number";
import { NumbersList } from "./numbers/numbers-list";
import { SipConnections } from "./numbers/sip-connections";

const WAYS = [
  {
    key: "existing",
    title: "Use my existing number",
    text: "Keep the number customers already call (Ooredoo, Vodafone or any carrier) and forward it to your agent.",
  },
  {
    key: "new",
    title: "Get a new number",
    text: "A new Twilio number that rings your agent straight away.",
  },
  {
    key: "sip",
    title: "Connect over SIP",
    text: "For a business SIP line or office PBX: calls come in over SIP with no forwarding.",
  },
] as const;
type Way = (typeof WAYS)[number]["key"];

export function PhoneNumbersPage() {
  const canWrite = useCan("phone_numbers:write");
  const [way, setWay] = useState<Way | null>(null);

  return (
    <>
      <PageHeader
        title="Phone numbers"
        description="How callers reach your agents: your existing number, a new number, or your SIP line."
      />
      {canWrite ? (
        <section aria-labelledby="add-heading" className="mb-6">
          <h2 id="add-heading" className="sr-only">
            Add a way for customers to call
          </h2>
          <div
            role="tablist"
            aria-label="Add a way for customers to call"
            className="grid gap-3 md:grid-cols-3"
          >
            {WAYS.map((w) => (
              <button
                key={w.key}
                role="tab"
                id={`way-${w.key}`}
                aria-selected={way === w.key}
                aria-controls="way-panel"
                onClick={() => setWay(way === w.key ? null : w.key)}
                className={cn(
                  "rounded-2xl border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-brand-500",
                  way === w.key
                    ? "border-brand-500 bg-brand-50 dark:border-brand-500 dark:bg-slate-800"
                    : "border-slate-200 bg-white hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700",
                )}
              >
                <span className="block font-semibold">{w.title}</span>
                <span className="mt-1 block text-sm text-slate-500">{w.text}</span>
              </button>
            ))}
          </div>
          {way ? (
            <div id="way-panel" role="tabpanel" aria-labelledby={`way-${way}`} className="mt-4">
              {way === "existing" ? (
                <ExistingNumberWizard onGetNumber={() => setWay("new")} onDone={() => setWay(null)} />
              ) : way === "new" ? (
                <GetNumber onDone={() => setWay(null)} />
              ) : (
                <SipConnections />
              )}
            </div>
          ) : null}
        </section>
      ) : null}

      <NumbersList />
      {way !== "sip" ? <SipConnections listOnly /> : null}
      <BlockedCallers />
    </>
  );
}
