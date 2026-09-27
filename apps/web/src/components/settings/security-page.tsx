"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { useMe } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { TextField } from "@/components/ui/field";
import { Section } from "@/components/ui/inputs";
import { Alert, Badge, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { fmtDateTime } from "@/lib/format";

type Session = {
  id: string;
  signedInAt: string;
  lastActiveAt: string;
  userAgent: string | null;
  ip: string | null;
  current: boolean;
};

export function SecurityPage() {
  return (
    <>
      <PageHeader title="Security" description="Protect your sign-in and see where you're signed in." />
      <div className="space-y-6">
        <TwoFactor />
        <Sessions />
      </div>
    </>
  );
}

function TwoFactor() {
  const me = useMe();
  const router = useRouter();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (!setup) return setQr(null);
    // Drawn in the browser: the secret never goes to a third-party QR service
    void QRCode.toDataURL(setup.otpauthUrl, { margin: 1, width: 200 }).then(setQr);
  }, [setup]);

  const start = useMutation({
    mutationFn: () => api<{ secret: string; otpauthUrl: string }>("/auth/2fa/setup", { method: "POST" }),
    onSuccess: setSetup,
  });
  const enable = useMutation({
    mutationFn: () =>
      api<{ recoveryCodes: string[] }>("/auth/2fa/enable", { method: "POST", body: { code } }),
    onSuccess: (r) => {
      setRecoveryCodes(r.recoveryCodes);
      setSetup(null);
      setCode("");
      router.refresh();
    },
  });
  const disable = useMutation({
    mutationFn: () => api("/auth/2fa/disable", { method: "POST", body: { password, code } }),
    onSuccess: () => {
      setDisabling(false);
      setPassword("");
      setCode("");
      router.refresh();
    },
  });
  const error = start.error ?? enable.error ?? disable.error;
  const enabled = me.user.totpEnabled;

  return (
    <Section
      title="Two-step sign-in"
      description="After your password, enter a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…)."
      actions={enabled ? <Badge>On</Badge> : <Badge>Off</Badge>}
    >
      {error ? (
        <div className="mb-4">
          <Alert>{errorMessage(error)}</Alert>
        </div>
      ) : null}

      {recoveryCodes ? (
        <div className="mb-4">
          <Alert tone="success">
            Two-step sign-in is on. Save these recovery codes somewhere safe: each one signs you in once if
            you lose your phone. They won't be shown again.
            <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm sm:grid-cols-5">
              {recoveryCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <div className="mt-2">
              <CopyButton text={recoveryCodes.join("\n")} label="Copy codes" />
            </div>
          </Alert>
        </div>
      ) : null}

      {!enabled && !setup ? (
        <Button onClick={() => start.mutate()} loading={start.isPending}>
          Turn on two-step sign-in
        </Button>
      ) : null}

      {setup ? (
        <form
          className="grid gap-6 md:grid-cols-[auto_1fr]"
          onSubmit={(e) => {
            e.preventDefault();
            enable.mutate();
          }}
        >
          <div className="rounded-xl bg-white p-2">
            {qr ? (
              <img
                src={qr}
                width={200}
                height={200}
                alt="QR code to add this account to an authenticator app"
              />
            ) : (
              <div className="size-[200px]" />
            )}
          </div>
          <div className="space-y-4 text-sm">
            <ol className="list-decimal space-y-1 pl-5">
              <li>Open your authenticator app and scan the QR code.</li>
              <li>
                Can't scan? Enter this key instead:{" "}
                <code className="font-mono break-all">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>{" "}
                <CopyButton text={setup.secret} />
              </li>
              <li>Enter the 6-digit code the app shows.</li>
            </ol>
            <TextField
              label="Code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="max-w-48"
            />
            <div className="flex gap-2">
              <Button type="submit" loading={enable.isPending} disabled={!/^\d{6}$/.test(code.trim())}>
                Turn on
              </Button>
              <Button type="button" variant="ghost" onClick={() => setSetup(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </form>
      ) : null}

      {enabled && !disabling ? (
        <Button variant="secondary" onClick={() => setDisabling(true)}>
          Turn off
        </Button>
      ) : null}
      {enabled && disabling ? (
        <form
          className="grid max-w-xl gap-4 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            disable.mutate();
          }}
        >
          <TextField
            label="Your password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <TextField
            label="Code or recovery code"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <div className="flex gap-2 md:col-span-2">
            <Button
              type="submit"
              variant="danger"
              loading={disable.isPending}
              disabled={!password || code.trim().length < 6}
            >
              Turn off two-step sign-in
            </Button>
            <Button type="button" variant="ghost" onClick={() => setDisabling(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </Section>
  );
}

/** "Chrome on Windows" from a user agent, enough to recognise a device */
function device(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad/.test(ua)
        ? "iOS"
        : /Mac OS X/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}

function Sessions() {
  const qc = useQueryClient();
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api<{ items: Session[] }>("/auth/sessions"),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["sessions"] });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/auth/sessions/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  const revokeOthers = useMutation({
    mutationFn: () => api<{ revoked: number }>("/auth/sessions/revoke-others", { method: "POST" }),
    onSuccess: refresh,
  });
  const items = sessions.data?.items ?? [];
  const error = revoke.error ?? revokeOthers.error;

  return (
    <Section
      title="Where you're signed in"
      description="Sign out anywhere you don't recognise. It takes effect straight away."
      actions={
        items.length > 1 ? (
          <Button variant="secondary" loading={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>
            Sign out everywhere else
          </Button>
        ) : null
      }
    >
      {error ? (
        <div className="mb-4">
          <Alert>{errorMessage(error)}</Alert>
        </div>
      ) : null}
      {revokeOthers.data ? (
        <div className="mb-4">
          <Alert tone="success">Signed out of {revokeOthers.data.revoked} other sessions.</Alert>
        </div>
      ) : null}
      <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
        {items.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-48 flex-1">
              <p className="font-medium">
                {device(s.userAgent)} {s.current ? <Badge>This device</Badge> : null}
              </p>
              <p className="text-slate-500">
                {s.ip ?? "Unknown address"} · signed in {fmtDateTime(s.signedInAt)} · active{" "}
                {fmtDateTime(s.lastActiveAt)}
              </p>
            </div>
            {s.current ? null : (
              <Button variant="ghost" className="h-9 text-red-600" onClick={() => revoke.mutate(s.id)}>
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}
