"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { useMe } from "./me-context";

type NavItem = { label: string; href: string; permission?: string; soon?: boolean };

const NAV: { section?: string; items: NavItem[] }[] = [
  {
    items: [
      { label: "Dashboard", href: "dashboard" },
      { label: "AI Agents", href: "agents", permission: "agents:read" },
      { label: "Knowledge Base", href: "knowledge", permission: "knowledge:read" },
      { label: "Calls", href: "calls", permission: "calls:read" },
      { label: "Leads", href: "leads", permission: "leads:read" },
      { label: "Appointments", href: "appointments", permission: "appointments:read" },
      { label: "Integrations", href: "integrations", permission: "integrations:read" },
      { label: "Analytics", href: "analytics", permission: "analytics:read" },
    ],
  },
  {
    section: "Settings",
    items: [
      { label: "Members", href: "settings/members", permission: "users:read" },
      { label: "Phone numbers", href: "settings/phone-numbers", permission: "phone_numbers:read" },
      { label: "Lead statuses", href: "settings/lead-statuses", permission: "leads:read" },
      { label: "API keys", href: "settings/api-keys", permission: "api_keys:read" },
      { label: "Audit log", href: "settings/audit-log", permission: "audit:read" },
    ],
  },
];

export function AppShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const base = `/t/${me.tenant.slug}`;

  const logout = async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  };

  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-6">
      {NAV.map((group, i) => {
        const items = group.items.filter((it) => !it.permission || me.permissions.includes(it.permission));
        if (!items.length) return null;
        return (
          <div key={group.section ?? i}>
            {group.section ? (
              <p className="mb-2 px-3 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                {group.section}
              </p>
            ) : null}
            <ul className="space-y-0.5">
              {items.map((it) => {
                const href = `${base}/${it.href}`;
                const active = pathname === href || pathname.startsWith(`${href}/`);
                return (
                  <li key={it.href}>
                    {it.soon ? (
                      <span
                        className="flex items-center justify-between rounded-lg px-3 py-2 text-sm text-slate-400"
                        aria-disabled
                      >
                        {it.label}
                        <span className="text-[10px] tracking-wide uppercase">soon</span>
                      </span>
                    ) : (
                      <Link
                        href={href}
                        onClick={() => setOpen(false)}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "block rounded-lg px-3 py-2 text-sm font-medium",
                          active
                            ? "bg-brand-50 text-brand-600 dark:bg-slate-800 dark:text-white"
                            : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
                        )}
                      >
                        {it.label}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[260px_1fr]">
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-64 border-r border-slate-200 bg-white p-4 transition-transform lg:static lg:w-auto lg:translate-x-0 dark:border-slate-800 dark:bg-slate-900",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <p className="mb-6 px-3 text-sm font-semibold text-brand-600">Voice Agent Platform</p>
        {nav}
      </aside>
      {open ? (
        <div
          className="fixed inset-0 z-30 bg-black/30 lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      ) : null}

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
          <button className="rounded-md p-2 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
            <span aria-hidden>☰</span>
          </button>
          <TenantSwitcher />
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-sm text-slate-500 sm:inline">
              {me.user.name} · {me.role.name}
            </span>
            <button
              onClick={logout}
              className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Sign out
            </button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}

function TenantSwitcher() {
  const me = useMe();
  const router = useRouter();
  if (me.memberships.length < 2)
    return <span className="truncate text-sm font-semibold">{me.tenant.name}</span>;
  return (
    <select
      aria-label="Switch business"
      className="h-9 max-w-[60vw] truncate rounded-lg border border-slate-300 bg-white px-2 text-sm font-semibold dark:border-slate-700 dark:bg-slate-900"
      value={me.tenant.slug}
      onChange={(e) => router.push(`/t/${e.target.value}/dashboard`)}
    >
      {me.memberships.map((m) => (
        <option key={m.tenantId} value={m.tenantSlug}>
          {m.tenantName}
        </option>
      ))}
    </select>
  );
}
