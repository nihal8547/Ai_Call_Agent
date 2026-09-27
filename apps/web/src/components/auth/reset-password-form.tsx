"use client";

import { Password } from "@platform/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Alert, Card } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";

export function ResetPasswordForm() {
  const router = useRouter();
  // The token is in the URL fragment (#…), which browsers never send to servers
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ password?: string; confirm?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = window.location.hash.slice(1);
    setToken(t.length >= 20 ? t : null);
    // Keep the token out of the address bar and history
    if (t) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const checked = Password.safeParse(password);
    const errors = {
      password: checked.success ? undefined : checked.error.issues[0]?.message,
      confirm: confirm === password ? undefined : "The passwords don't match",
    };
    setFieldErrors(errors);
    if (errors.password || errors.confirm || !token) return;
    setBusy(true);
    try {
      await api("/auth/password/reset", { method: "POST", body: { token, password } });
      router.replace("/login?reset=1");
    } catch (err) {
      if (err instanceof ApiError && err.problem.code === "TOKEN_EXPIRED") setExpired(true);
      else setError(errorMessage(err));
      setBusy(false);
    }
  };

  if (token === undefined) return <Card>{null}</Card>;
  if (token === null || expired)
    return (
      <Card>
        <h1 className="text-xl font-semibold">This link can't be used</h1>
        <p className="mt-2 text-sm text-slate-500">
          Reset links work once, for 30 minutes, and a newer link replaces older ones.
        </p>
        <Link
          href="/forgot-password"
          className="mt-6 inline-flex h-10 w-full items-center justify-center rounded-lg bg-slate-950 px-4 text-sm font-medium text-white hover:bg-slate-800"
        >
          Send a new link
        </Link>
      </Card>
    );

  return (
    <Card>
      <h1 className="text-xl font-semibold">Choose a new password</h1>
      <p className="mt-1 text-sm text-slate-500">
        You'll be signed out on every device, then sign in with the new one.
      </p>
      <form onSubmit={submit} noValidate className="mt-6 space-y-4">
        {error ? <Alert>{error}</Alert> : null}
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
          hint="At least 10 characters, with three of: lowercase, uppercase, number, symbol."
        />
        <TextField
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={fieldErrors.confirm}
        />
        <Button type="submit" className="w-full" loading={busy}>
          Change password
        </Button>
      </form>
    </Card>
  );
}
