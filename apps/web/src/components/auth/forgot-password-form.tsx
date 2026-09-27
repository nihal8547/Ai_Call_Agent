"use client";

import { ForgotPasswordBody } from "@platform/shared";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Alert, Card } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = ForgotPasswordBody.safeParse({ email });
    if (!parsed.success) return setFieldError("Enter a valid email address");
    setFieldError(null);
    setBusy(true);
    try {
      await api("/auth/password/forgot", { method: "POST", body: parsed.data });
      setSentTo(parsed.data.email);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h1 className="text-xl font-semibold">Forgot your password?</h1>
      {sentTo ? (
        <div className="mt-6 space-y-4">
          <Alert tone="success">
            If there is an account for <strong>{sentTo}</strong>, we've emailed a link to choose a new
            password. It works for 30 minutes.
          </Alert>
          <p className="text-sm text-slate-500">
            Nothing arrived? Check your spam folder, or{" "}
            <button
              type="button"
              className="font-medium text-slate-950 underline"
              onClick={() => setSentTo(null)}
            >
              try again
            </button>
            .
          </p>
        </div>
      ) : (
        <>
          <p className="mt-1 text-sm text-slate-500">
            Enter the email you sign in with, and we'll send you a link to choose a new password.
          </p>
          <form onSubmit={submit} noValidate className="mt-6 space-y-4">
            {error ? <Alert>{error}</Alert> : null}
            <TextField
              label="Email"
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={fieldError ?? undefined}
            />
            <Button type="submit" className="w-full" loading={busy}>
              Send reset link
            </Button>
          </form>
        </>
      )}
      <p className="mt-6 text-center text-sm text-slate-500">
        <Link href="/login" className="font-medium text-slate-950 hover:underline">
          Back to sign in
        </Link>
      </p>
    </Card>
  );
}
