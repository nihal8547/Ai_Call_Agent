"use client";

import { COUNTRIES, COUNTRY_CODES, type CountryCode } from "@platform/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useCan } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Section } from "@/components/ui/inputs";
import { Alert, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";

type Tenant = {
  id: string;
  name: string;
  slug: string;
  industry: string | null;
  timezone: string;
  country: CountryCode;
  callingCode: string;
  currency: string;
  retentionDays: number;
  maxCallMinutes: number;
};
type Form = Pick<Tenant, "name" | "timezone" | "country"> & { retentionDays: string; maxCallMinutes: string };

export function BusinessSettingsPage() {
  const canWrite = useCan("tenant:write");
  const router = useRouter();
  const tenant = useQuery({ queryKey: ["tenant"], queryFn: () => api<Tenant>("/tenant") });
  const [form, setForm] = useState<Form | null>(null);
  const zones = useMemo(() => Intl.supportedValuesOf("timeZone"), []);

  useEffect(() => {
    if (tenant.data && !form)
      setForm({
        name: tenant.data.name,
        timezone: tenant.data.timezone,
        country: tenant.data.country,
        retentionDays: String(tenant.data.retentionDays),
        maxCallMinutes: String(tenant.data.maxCallMinutes),
      });
  }, [tenant.data, form]);

  const save = useMutation({
    mutationFn: (f: Form) =>
      api<Tenant>("/tenant", {
        method: "PATCH",
        body: {
          name: f.name,
          timezone: f.timezone,
          country: f.country,
          retentionDays: Number(f.retentionDays),
          maxCallMinutes: Number(f.maxCallMinutes),
        },
      }),
    onSuccess: () => {
      void tenant.refetch();
      // The calling code and name live in the session's business details too
      router.refresh();
    },
  });
  const fieldError = (path: string) =>
    save.error instanceof ApiError ? save.error.fieldErrors.find((f) => f.path === path)?.message : undefined;
  const set = (k: keyof Form) => (e: { target: { value: string } }) =>
    setForm((f) => f && { ...f, [k]: e.target.value });

  if (!form || !tenant.data) return <PageHeader title="Business" />;
  const country = COUNTRIES[form.country];

  return (
    <>
      <PageHeader
        title="Business"
        description="Where you operate, and how calls and their records are handled."
      />
      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(form);
        }}
      >
        {save.isSuccess ? <Alert tone="success">Saved.</Alert> : null}
        {save.error && !(save.error instanceof ApiError && save.error.fieldErrors.length) ? (
          <Alert>{errorMessage(save.error)}</Alert>
        ) : null}
        <fieldset disabled={!canWrite} className="space-y-6">
          <Section title="Business details">
            <div className="grid gap-4 md:grid-cols-2">
              <TextField
                label="Business name"
                value={form.name}
                onChange={set("name")}
                error={fieldError("name")}
              />
              <SelectField
                label="Country"
                value={form.country}
                onChange={(e) => {
                  const next = e.target.value as CountryCode;
                  // Moving country usually means that country's time zone too
                  setForm((f) => f && { ...f, country: next, timezone: COUNTRIES[next].timezone });
                }}
                hint={`Calling code +${country.callingCode} · prices in ${country.currency}`}
              >
                {COUNTRY_CODES.map((c) => (
                  <option key={c} value={c}>
                    {COUNTRIES[c].name}
                  </option>
                ))}
              </SelectField>
              <TextField
                label="Time zone"
                list="tz-list"
                value={form.timezone}
                onChange={set("timezone")}
                error={fieldError("timezone")}
                hint="Opening hours and appointments use this time zone"
              />
              <datalist id="tz-list">
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </div>
          </Section>
          <Section title="Calls and records">
            <div className="grid gap-4 md:grid-cols-2">
              <TextField
                label="Longest call (minutes)"
                type="number"
                min={2}
                max={120}
                value={form.maxCallMinutes}
                onChange={set("maxCallMinutes")}
                error={fieldError("maxCallMinutes")}
                hint="The agent ends calls politely after this, so a stuck line can't run up costs"
              />
              <TextField
                label="Keep call records for (days)"
                type="number"
                min={30}
                max={3650}
                value={form.retentionDays}
                onChange={set("retentionDays")}
                error={fieldError("retentionDays")}
                hint="Transcripts and caller numbers on older calls are removed nightly. Call totals and leads stay."
              />
            </div>
          </Section>
        </fieldset>
        {canWrite ? (
          <Button type="submit" loading={save.isPending}>
            Save
          </Button>
        ) : null}
      </form>
    </>
  );
}
