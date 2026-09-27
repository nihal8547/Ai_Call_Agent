"use client";

import type { MeResponse } from "@platform/shared";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Alert, Card } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { applyServerErrors } from "@/lib/forms";
import type { LegalLinks } from "@/lib/legal";
import { TermsCheckbox } from "./terms-checkbox";

type Values = { name: string; password: string; acceptTerms: boolean };

/**
 * New users choose a name and password; people who already have an account enter their existing password.
 * The server decides which case applies and validates accordingly.
 */
export function AcceptInviteForm({ token, legal }: { token: string; legal: LegalLinks }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Values>({ defaultValues: { name: "", password: "", acceptTerms: false } });

  const onSubmit = form.handleSubmit(async ({ name, password, acceptTerms }) => {
    setError(null);
    try {
      const me = await api<MeResponse>("/invitations/accept", {
        method: "POST",
        body: { token, password, acceptTerms, ...(name.trim() ? { name: name.trim() } : {}) },
      });
      router.replace(`/t/${me.tenant.slug}/dashboard`);
      router.refresh();
    } catch (err) {
      if (!applyServerErrors(err, form.setError)) setError(errorMessage(err));
    }
  });

  return (
    <Card>
      <h1 className="text-xl font-semibold">Join your team</h1>
      <p className="mt-1 text-sm text-slate-500">
        New to the platform? Enter your name and choose a password. Already have an account? Just enter your
        password.
      </p>
      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
        {error ? <Alert>{error}</Alert> : null}
        <TextField
          label="Your name (new accounts)"
          autoComplete="name"
          error={form.formState.errors.name?.message}
          {...form.register("name")}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          error={form.formState.errors.password?.message}
          {...form.register("password", { required: "Enter a password" })}
        />
        <TermsCheckbox
          links={legal}
          error={form.formState.errors.acceptTerms?.message}
          {...form.register("acceptTerms")}
        />
        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
          Accept invitation
        </Button>
      </form>
    </Card>
  );
}
