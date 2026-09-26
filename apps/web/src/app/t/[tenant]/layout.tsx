import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app/app-shell";
import { MeProvider } from "@/components/app/me-context";
import { SessionGate, TenantSwitch } from "@/components/app/session-gate";
import { getMe } from "@/lib/api/server";

export const dynamic = "force-dynamic";

export default async function TenantLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ tenant: string }>;
}) {
  const { tenant } = await params;
  const me = await getMe();
  if (!me) return <SessionGate />;

  if (me.tenant.slug !== tenant) {
    const membership = me.memberships.find((m) => m.tenantSlug === tenant);
    if (membership) return <TenantSwitch tenantId={membership.tenantId} />;
    redirect(`/t/${me.tenant.slug}/dashboard`);
  }

  return (
    <MeProvider me={me}>
      <AppShell>{children}</AppShell>
    </MeProvider>
  );
}
