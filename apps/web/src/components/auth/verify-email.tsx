"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Alert, Card } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";

const linkButton =
  "mt-6 inline-flex h-10 w-full items-center justify-center rounded-lg bg-slate-950 px-4 text-sm font-medium text-white hover:bg-slate-800";

/** Opened from the "Confirm your email" link: confirms straight away, in any browser */
export function VerifyEmail() {
  const [state, setState] = useState<"working" | "done" | "expired" | { error: string }>("working");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // The token is in the URL fragment (#…), which browsers never send to servers
    const token = window.location.hash.slice(1);
    if (token) window.history.replaceState(null, "", window.location.pathname);
    if (token.length < 20) {
      setState("expired");
      return;
    }
    api("/auth/verify-email", { method: "POST", body: { token } })
      .then(() => setState("done"))
      .catch((err: unknown) =>
        setState(
          err instanceof ApiError && err.problem.code === "TOKEN_EXPIRED"
            ? "expired"
            : { error: errorMessage(err) },
        ),
      );
  }, []);

  if (state === "working")
    return (
      <Card>
        <p className="text-sm text-slate-500" role="status">
          Confirming your email…
        </p>
      </Card>
    );
  if (state === "done")
    return (
      <Card>
        <h1 className="text-xl font-semibold">Email confirmed</h1>
        <p className="mt-2 text-sm text-slate-500">
          Thanks. You can now get phone numbers, connect WhatsApp and invite your team.
        </p>
        <Link href="/" className={linkButton}>
          Continue
        </Link>
      </Card>
    );
  if (state === "expired")
    return (
      <Card>
        <h1 className="text-xl font-semibold">This link can't be used</h1>
        <p className="mt-2 text-sm text-slate-500">
          Links work for 24 hours, once, and a newer link replaces older ones. Sign in and choose{" "}
          <strong>Send the link again</strong> at the top of the page.
        </p>
        <Link href="/login" className={linkButton}>
          Sign in
        </Link>
      </Card>
    );
  return (
    <Card>
      <Alert>{state.error}</Alert>
    </Card>
  );
}
