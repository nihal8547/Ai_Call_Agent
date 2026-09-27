"use client";

import { MailWarning } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { useMe } from "./me-context";

type Sent = { sent: boolean; alreadyVerified?: true; devUrl?: string };

/** Until the email is confirmed: what waits for it, and "send again" */
export function VerifyEmailBanner() {
  const me = useMe();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; devUrl?: string } | null>(null);

  // Confirmed in another tab: pick it up when this one is looked at again
  useEffect(() => {
    if (me.user.emailVerified) return;
    const onFocus = () => router.refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [me.user.emailVerified, router]);

  if (me.user.emailVerified) return null;

  const resend = async () => {
    setBusy(true);
    try {
      const res = await api<Sent>("/auth/verify-email/resend", { method: "POST", body: {} });
      if (res.alreadyVerified) router.refresh();
      else if (res.sent) setNote({ text: `Sent. Check ${me.user.email} (and the spam folder).` });
      else
        setNote({
          text: "This server can't send email yet. Ask the platform's operator to set up email.",
          ...(res.devUrl ? { devUrl: res.devUrl } : {}),
        });
    } catch (err) {
      setNote({ text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:px-6 lg:px-10 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2">
        <MailWarning className="size-4 shrink-0" aria-hidden />
        <p className="min-w-0 flex-1">
          <strong className="font-semibold">Confirm your email.</strong> Open the link we sent to{" "}
          <span className="font-medium break-all">{me.user.email}</span>. Until then you can build and test
          agents, but not get phone numbers, connect WhatsApp or invite your team.
          {note ? (
            <span className="mt-1 block">
              {note.text}{" "}
              {note.devUrl ? (
                <a className="font-medium underline" href={note.devUrl}>
                  Open the link (development)
                </a>
              ) : null}
            </span>
          ) : null}
        </p>
        <Button variant="secondary" loading={busy} onClick={resend}>
          Send the link again
        </Button>
      </div>
    </div>
  );
}
