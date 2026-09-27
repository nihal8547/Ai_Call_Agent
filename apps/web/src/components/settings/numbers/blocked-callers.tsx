"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useCan } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Section } from "@/components/ui/inputs";
import { Alert } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { fmtDateTime } from "@/lib/format";
import type { BlockedCaller } from "@/lib/types";

export function BlockedCallers() {
  const canWrite = useCan("phone_numbers:write");
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["blocked-callers"],
    queryFn: () => api<{ items: BlockedCaller[] }>("/blocked-callers"),
  });
  const [pattern, setPattern] = useState("");
  const [reason, setReason] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["blocked-callers"] });
  const add = useMutation({
    mutationFn: () =>
      api("/blocked-callers", {
        method: "POST",
        body: {
          pattern: pattern.replace(/[\s()-]/g, ""),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
      }),
    onSuccess: () => {
      setPattern("");
      setReason("");
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/blocked-callers/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  const fieldError =
    add.error instanceof ApiError
      ? add.error.fieldErrors.find((f) => f.path === "pattern")?.message
      : undefined;
  const items = list.data?.items ?? [];

  return (
    <div className="mt-6">
      <Section title="Blocked callers" description="Your agents never answer these numbers.">
        {canWrite ? (
          <form
            className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-start"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <TextField
              label="Number or range"
              placeholder="+97455123456 or +882*"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              error={fieldError}
              hint="End with * to block every number that starts with it"
            />
            <TextField
              label="Reason (optional)"
              placeholder="Spam"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <Button type="submit" className="md:mt-7" loading={add.isPending} disabled={!pattern.trim()}>
              Block
            </Button>
          </form>
        ) : null}
        {(add.error && !fieldError) || remove.error ? (
          <div className="mt-4">
            <Alert>{errorMessage(add.error ?? remove.error)}</Alert>
          </div>
        ) : null}
        {items.length ? (
          <ul className="mt-4 divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {items.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="font-mono tabular-nums">{b.pattern}</span>
                <span className="text-slate-500">{b.reason ?? ""}</span>
                <span className="text-xs text-slate-500">{fmtDateTime(b.createdAt)}</span>
                {canWrite ? (
                  <Button variant="ghost" className="ml-auto h-8" onClick={() => remove.mutate(b.id)}>
                    Unblock
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : list.data ? (
          <p className="mt-4 text-sm text-slate-500">Nobody is blocked.</p>
        ) : null}
      </Section>
    </div>
  );
}
