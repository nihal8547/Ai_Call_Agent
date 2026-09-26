"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useCan, useMe } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { Check } from "@/components/ui/inputs";
import { Alert, Card, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import type { Integration } from "@/lib/types";

type Source = { key: string; label: string; type: string; options?: string[]; agents: string[] };
type Property = {
  name: string;
  label: string;
  type: string;
  options?: { label: string; value: string }[];
  required?: boolean;
};
type MappingView = {
  syncLeads: boolean;
  mapping: Record<string, string>;
  sources: Source[];
  properties: Property[];
  error: string | null;
  problems: { source: string; message: string }[];
};

/** CRM field types each kind of answer can be written to (the API checks this too) */
const COMPATIBLE: Record<string, string[]> = {
  text: ["string"],
  name: ["string"],
  time: ["string"],
  number: ["number", "string"],
  currency: ["number", "string"],
  select: ["enum", "string"],
  multiselect: ["multienum", "string"],
  boolean: ["bool", "string"],
  date: ["date", "datetime", "string"],
  phone: ["phone", "string"],
  email: ["email", "string"],
};
const TYPE_WORD: Record<string, string> = {
  text: "Text",
  name: "Name",
  time: "Time",
  number: "Number",
  currency: "Amount",
  select: "Choice",
  multiselect: "Choices",
  boolean: "Yes / no",
  date: "Date",
  phone: "Phone",
  email: "Email",
};

/** Which caller answers go to which CRM fields */
export function CrmMappingPage({ id }: { id: string }) {
  const me = useMe();
  const qc = useQueryClient();
  const canWrite = useCan("integrations:write");
  const integration = useQuery({
    queryKey: ["integrations"],
    queryFn: () => api<{ items: Integration[] }>("/integrations"),
    select: (d) => d.items.find((i) => i.id === id),
  });
  const [refresh, setRefresh] = useState(0);
  const view = useQuery({
    queryKey: ["crm-mapping", id, refresh],
    queryFn: () => api<MappingView>(`/integrations/${id}/crm-mapping${refresh ? "?refresh=1" : ""}`),
  });
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [syncLeads, setSyncLeads] = useState(true);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!view.data) return;
    setMapping(view.data.mapping);
    setSyncLeads(view.data.syncLeads);
  }, [view.data]);

  const save = useMutation({
    mutationFn: () =>
      api(`/integrations/${id}/crm-mapping`, {
        method: "PUT",
        body: { syncLeads, mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)) },
      }),
    onSuccess: async () => {
      setSaved(true);
      await qc.invalidateQueries({ queryKey: ["crm-mapping", id] });
      await qc.invalidateQueries({ queryKey: ["integrations"] });
    },
  });
  const fieldErrors = save.error instanceof ApiError ? save.error.fieldErrors : [];
  const problemFor = (key: string) =>
    fieldErrors.find((e) => e.path === `mapping.${key}`)?.message ??
    (save.isIdle ? view.data?.problems.find((p) => p.source === key)?.message : undefined);
  const crm = integration.data?.type === "ZOHO" ? "Zoho CRM" : "HubSpot";
  const d = view.data;
  const used = new Set(Object.values(mapping).filter(Boolean));

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={`/t/${me.tenant.slug}/integrations`} className="text-slate-500 hover:underline">
          ← Integrations
        </Link>
      </p>
      <PageHeader
        title={`${integration.data?.name ?? crm}: field mapping`}
        description={`Choose where each answer your agents collect goes in ${crm}. Name, phone and email always go to the ${integration.data?.type === "ZOHO" ? "lead" : "contact"}'s own fields.`}
        actions={
          <Button variant="secondary" loading={view.isFetching} onClick={() => setRefresh((n) => n + 1)}>
            Reload {crm} fields
          </Button>
        }
      />
      <div className="space-y-4">
        {view.error ? <Alert>{errorMessage(view.error)}</Alert> : null}
        {d?.error ? (
          <Alert>
            Couldn&apos;t read the fields from {crm}: {d.error}
          </Alert>
        ) : null}
        {save.error && !fieldErrors.length ? <Alert>{errorMessage(save.error)}</Alert> : null}
        {fieldErrors.length ? (
          <Alert>Some answers can&apos;t go to the chosen fields. See below.</Alert>
        ) : null}
        {saved && save.isSuccess ? <Alert tone="success">Mapping saved. The next leads use it.</Alert> : null}

        <Card>
          <Check
            label={`Send leads to ${crm} after every call and when staff edit them`}
            checked={syncLeads}
            onChange={(v) => {
              setSyncLeads(v);
              setSaved(false);
            }}
            disabled={!canWrite}
          />
        </Card>

        {d && d.properties.length ? (
          <Card className="p-0">
            <table className="w-full text-sm">
              <caption className="sr-only">Answers and the {crm} field each goes to</caption>
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500 dark:border-slate-800">
                  <th scope="col" className="px-4 py-3 font-medium">
                    Answer
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    {crm} field
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.sources.map((s) => {
                  const allowed = COMPATIBLE[s.type] ?? ["string"];
                  const choices = d.properties.filter(
                    (p) => allowed.includes(p.type) && (!used.has(p.name) || mapping[s.key] === p.name),
                  );
                  const problem = problemFor(s.key);
                  return (
                    <tr
                      key={s.key}
                      className="border-b border-slate-100 align-top last:border-0 dark:border-slate-800"
                    >
                      <td className="px-4 py-3">
                        <p className="font-medium">{s.label}</p>
                        <p className="text-xs text-slate-500">
                          {TYPE_WORD[s.type] ?? s.type}
                          {s.agents.length ? ` · asked by ${s.agents.join(", ")}` : " · from the call"}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <select
                          aria-label={`${crm} field for ${s.label}`}
                          value={mapping[s.key] ?? ""}
                          disabled={!canWrite}
                          aria-invalid={Boolean(problem)}
                          onChange={(e) => {
                            setMapping((m) => ({ ...m, [s.key]: e.target.value }));
                            setSaved(false);
                          }}
                          className="h-10 w-full max-w-sm rounded-lg border border-slate-300 bg-white px-2 text-sm aria-invalid:border-red-500 dark:border-slate-700 dark:bg-slate-900"
                        >
                          <option value="">Don&apos;t send</option>
                          {choices.map((p) => (
                            <option key={p.name} value={p.name}>
                              {p.label} ({p.name})
                            </option>
                          ))}
                        </select>
                        {problem ? (
                          <p className="mt-1 text-sm text-red-600 dark:text-red-400">{problem}</p>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        ) : null}
        {d && !d.sources.length ? (
          <Card>
            <p className="text-sm text-slate-500">Your agents don&apos;t ask any questions yet.</p>
          </Card>
        ) : null}
        {canWrite ? (
          <div className="flex justify-end">
            <Button loading={save.isPending} onClick={() => save.mutate()} disabled={!d || Boolean(d.error)}>
              Save mapping
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );
}
