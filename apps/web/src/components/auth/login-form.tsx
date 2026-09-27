"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { LoginBody, type MeResponse } from "@platform/shared";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useState } from "react";
import { useForm } from "react-hook-form";
import { type z } from "zod";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Alert, Card } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { applyServerErrors } from "@/lib/forms";

type Values = z.input<typeof LoginBody>;

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next");
  const justReset = params.get("reset") === "1";
  const [error, setError] = useState<string | null>(null);
  // Set when the password was right and the account has two-step sign-in
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(LoginBody),
    defaultValues: { email: "", password: "" },
  });

  const signedIn = (me: MeResponse) => {
    // Only follow same-app relative paths (no open redirects)
    const safeNext = next?.startsWith("/t/") ? next : null;
    router.replace(safeNext ?? `/t/${me.tenant.slug}/dashboard`);
    router.refresh();
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const res = await api<MeResponse | { mfaRequired: true; mfaToken: string }>("/auth/login", {
        method: "POST",
        body: values,
      });
      if ("mfaRequired" in res) setMfaToken(res.mfaToken);
      else signedIn(res);
    } catch (err) {
      if (!applyServerErrors(err, form.setError)) setError(errorMessage(err));
    }
  });

  if (mfaToken)
    return (
      <MfaStep
        mfaToken={mfaToken}
        onSignedIn={signedIn}
        onRestart={() => {
          setMfaToken(null);
          form.setValue("password", "");
        }}
      />
    );

  return (
    <Card>
      <h1 className="text-xl font-semibold">Sign in</h1>
      <p className="mt-1 text-sm text-slate-500">Manage your AI voice agents.</p>
      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
        {justReset && !error ? (
          <Alert tone="success">Your password was changed. Sign in with the new one.</Alert>
        ) : null}
        {error ? <Alert>{error}</Alert> : null}
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          error={form.formState.errors.email?.message}
          {...form.register("email")}
        />
        <div>
          <TextField
            label="Password"
            type="password"
            autoComplete="current-password"
            error={form.formState.errors.password?.message}
            {...form.register("password")}
          />
          <p className="mt-1.5 text-right text-sm">
            <Link
              href="/forgot-password"
              className="font-medium text-slate-600 hover:text-slate-950 hover:underline"
            >
              Forgot password?
            </Link>
          </p>
        </div>
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

function MfaStep({
  mfaToken,
  onSignedIn,
  onRestart,
}: {
  mfaToken: string;
  onSignedIn: (me: MeResponse) => void;
  onRestart: () => void;
}) {
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      onSignedIn(await api<MeResponse>("/auth/login/2fa", { method: "POST", body: { mfaToken, code } }));
    } catch (err) {
      // The sign-in ticket is gone (expired or too many tries): start again from the password
      if (err instanceof ApiError && err.status === 401 && /start again|sign in again/i.test(err.message))
        onRestart();
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Card>
      <h1 className="text-xl font-semibold">Two-step sign-in</h1>
      <p className="mt-1 text-sm text-slate-500">
        {recovery
          ? "Enter one of the recovery codes you saved when you turned on two-step sign-in."
          : "Enter the 6-digit code from your authenticator app."}
      </p>
      <form onSubmit={submit} noValidate className="mt-6 space-y-4">
        {error ? <Alert>{error}</Alert> : null}
        <TextField
          key={recovery ? "recovery" : "totp"}
          label={recovery ? "Recovery code" : "Code"}
          autoComplete="one-time-code"
          inputMode={recovery ? "text" : "numeric"}
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <Button type="submit" className="w-full" loading={busy} disabled={code.trim().length < 6}>
          Verify
        </Button>
      </form>
      <div className="mt-6 flex justify-between text-sm">
        <button
          type="button"
          className="font-medium text-brand-600 hover:underline"
          onClick={() => {
            setRecovery(!recovery);
            setCode("");
          }}
        >
          {recovery ? "Use my authenticator app" : "Use a recovery code"}
        </button>
        <button type="button" className="text-slate-500 hover:underline" onClick={onRestart}>
          Back
        </button>
      </div>
    </Card>
  );
}
