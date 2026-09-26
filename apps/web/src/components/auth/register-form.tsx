"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { type MeResponse, RegisterBody } from "@platform/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { type z } from "zod";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Alert, Card } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { applyServerErrors } from "@/lib/forms";

type Values = z.input<typeof RegisterBody>;

export function RegisterForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(RegisterBody),
    defaultValues: {
      name: "",
      email: "",
      password: "",
      businessName: "",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata",
    },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const me = await api<MeResponse>("/auth/register", { method: "POST", body: values });
      router.replace(`/t/${me.tenant.slug}/dashboard`);
      router.refresh();
    } catch (err) {
      if (!applyServerErrors(err, form.setError)) setError(errorMessage(err));
    }
  });

  return (
    <Card>
      <h1 className="text-xl font-semibold">Create your business account</h1>
      <p className="mt-1 text-sm text-slate-500">Set up AI voice agents for your business in minutes.</p>
      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
        {error ? <Alert>{error}</Alert> : null}
        <TextField
          label="Business name"
          autoComplete="organization"
          error={errors.businessName?.message}
          {...form.register("businessName")}
        />
        <TextField
          label="Your name"
          autoComplete="name"
          error={errors.name?.message}
          {...form.register("name")}
        />
        <TextField
          label="Work email"
          type="email"
          autoComplete="email"
          error={errors.email?.message}
          {...form.register("email")}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="At least 10 characters, with three of: lowercase, uppercase, number, symbol."
          error={errors.password?.message}
          {...form.register("password")}
        />
        <input type="hidden" {...form.register("timezone")} />
        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
          Create account
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-500">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-brand-600 hover:underline">
          Sign in
        </Link>
      </p>
    </Card>
  );
}
