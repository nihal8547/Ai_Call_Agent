"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { api, refreshSession } from "@/lib/api/client";

/**
 * Rendered by the server when the access token is missing/expired. The refresh cookie is only
 * sent to /api/v1/auth, so the browser refreshes the session here, then re-renders the page.
 */
export function SessionGate() {
  const router = useRouter();
  const next = usePathname();
  useEffect(() => {
    void refreshSession().then((ok) => {
      if (ok) router.refresh();
      else router.replace(`/login?next=${encodeURIComponent(next)}`);
    });
  }, [next, router]);
  return <FullPageSpinner label="Restoring your session…" />;
}

/** The URL names a business the session is not currently signed into, but the user is a member of it */
export function TenantSwitch({ tenantId }: { tenantId: string }) {
  const router = useRouter();
  useEffect(() => {
    void api("/auth/switch-tenant", { method: "POST", body: { tenantId } }).then(() => router.refresh());
  }, [tenantId, router]);
  return <FullPageSpinner label="Switching business…" />;
}

export function FullPageSpinner({ label }: { label: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center gap-3 text-sm text-slate-500" role="status">
      <span
        className="size-5 animate-spin rounded-full border-2 border-brand-500 border-t-transparent"
        aria-hidden
      />
      {label}
    </div>
  );
}
