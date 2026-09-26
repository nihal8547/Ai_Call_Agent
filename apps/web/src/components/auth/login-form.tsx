"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { LoginBody, type MeResponse } from "@platform/shared";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { type z } from "zod";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Alert, Card } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { applyServerErrors } from "@/lib/forms";

type Values = z.input<typeof LoginBody>;

export function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get("next");
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(LoginBody),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const me = await api<MeResponse>("/auth/login", { method: "POST", body: values });
      // Only follow same-app relative paths (no open redirects)
      const safeNext = next?.startsWith("/t/") ? next : null;
      router.replace(safeNext ?? `/t/${me.tenant.slug}/dashboard`);
      router.refresh();
    } catch (err) {
      if (!applyServerErrors(err, form.setError)) setError(errorMessage(err));
    }
  });

  return (
    <Card>
      <h1 className="text-xl font-semibold">Sign in</h1>
      <p className="mt-1 text-sm text-slate-500">Manage your AI voice agents.</p>
      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
        {error ? <Alert>{error}</Alert> : null}
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          error={form.formState.errors.email?.message}
          {...form.register("email")}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          error={form.formState.errors.password?.message}
          {...form.register("password")}
        />
        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
          Sign in
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-500">
        New here?{" "}
        <Link href="/register" className="font-medium text-brand-600 hover:underline">
          Create a business account
        </Link>
      </p>
    </Card>
  );
}
