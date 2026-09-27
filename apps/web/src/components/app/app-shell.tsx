"use client";

import {
  AudioLines,
  BarChart3,
  BookOpen,
  Bot,
  Building2,
  CalendarDays,
  ChevronsUpDown,
  Globe2,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Inbox,
  Menu,
  MessageCircle,
  PhoneCall,
  PhoneForwarded,
  Plug,
  ScrollText,
  ShieldCheck,
  UserRoundCog,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type AnchorHTMLAttributes, type ComponentProps, type ReactNode, useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { VerifyEmailBanner } from "./verify-email-banner";
import { useMe } from "./me-context";

type NavItem = { label: string; href: string; icon: LucideIcon; permission?: string };

/** The sidebar, grouped by what people come to do */
const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Overview",
    items: [
      { label: "Dashboard", href: "dashboard", icon: LayoutDashboard },
      { label: "Analytics", href: "analytics", icon: BarChart3, permission: "analytics:read" },
    ],
  },
  {
    group: "Agents",
    items: [
      { label: "AI Agents", href: "agents", icon: Bot, permission: "agents:read" },
      { label: "Knowledge Base", href: "knowledge", icon: BookOpen, permission: "knowledge:read" },
    ],
  },
  {
    group: "Customers",
    items: [
      { label: "Inbox", href: "inbox", icon: Inbox, permission: "chats:read" },
      { label: "Calls", href: "calls", icon: PhoneCall, permission: "calls:read" },
      { label: "Leads", href: "leads", icon: Users, permission: "leads:read" },
      { label: "Appointments", href: "appointments", icon: CalendarDays, permission: "appointments:read" },
    ],
  },
  {
    group: "Connections",
    items: [
      {
        label: "Phone numbers",
        href: "settings/phone-numbers",
        icon: PhoneForwarded,
        permission: "phone_numbers:read",
      },
      { label: "WhatsApp", href: "settings/whatsapp", icon: MessageCircle, permission: "chats:read" },
      { label: "Integrations", href: "integrations", icon: Plug, permission: "integrations:read" },
    ],
  },
  {
    group: "Workspace",
    items: [
      { label: "Business", href: "settings/business", icon: Building2, permission: "tenant:read" },
      { label: "Members", href: "settings/members", icon: UserRoundCog, permission: "users:read" },
      { label: "Lead statuses", href: "settings/lead-statuses", icon: ListChecks, permission: "leads:read" },
      { label: "API keys", href: "settings/api-keys", icon: KeyRound, permission: "api_keys:read" },
      { label: "Security", href: "settings/security", icon: ShieldCheck },
      { label: "Audit log", href: "settings/audit-log", icon: ScrollText, permission: "audit:read" },
    ],
  },
];

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

export function AppShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const base = `/t/${me.tenant.slug}`;
  const wide = pathname === `${base}/inbox`;
  const canChat = me.permissions.includes("chats:read");
  const unread = useQuery({
    queryKey: ["chats-unread"],
    queryFn: () => api<{ conversations: number }>("/chats/unread"),
    enabled: canChat,
    refetchInterval: 15_000,
  });

  // The mobile menu closes when you go somewhere, and on Escape
  useEffect(() => {
    setOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    // The page behind the open menu must not scroll
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const logout = async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  };

  const groups = [
    ...NAV,
    // The operator's console, for platform owners only (the API checks it too)
    ...(me.user.isPlatformOwner
      ? [{ group: "Platform", items: [{ label: "Businesses", href: "platform", icon: Globe2 }] }]
      : []),
  ]
    .map((g) => ({
      ...g,
      items: g.items.filter((it: NavItem) => !it.permission || me.permissions.includes(it.permission)),
    }))
    .filter((g) => g.items.length);

  return (
    <div className="min-h-dvh bg-white">
      {/* Sidebar: fixed with its own scrolling, so it stays put however long the page is */}
      <aside
        id="app-sidebar"
        aria-label="Sidebar"
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-[272px] flex-col border-r border-slate-200 bg-white transition-transform duration-200 ease-out lg:translate-x-0",
          open ? "translate-x-0 shadow-2xl lg:shadow-none" : "-translate-x-full",
        )}
      >
        <div className="flex h-16 shrink-0 items-center gap-3 px-5">
          <span className="grid size-8 place-items-center rounded-lg bg-slate-950 text-white">
            <AudioLines className="size-4" aria-hidden />
          </span>
          <span className="leading-tight">
            <span className="block text-[15px] font-semibold tracking-tight text-slate-950">Voice Agent</span>
            <span className="block text-xs text-slate-500">Platform</span>
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close menu"
            className="ml-auto rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-950 lg:hidden"
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>

        <div className="px-3 pb-2">
          <TenantSwitcher />
        </div>

        <nav aria-label="Main" className="flex-1 overflow-y-auto overscroll-contain px-3 pt-2 pb-6">
          {groups.map((g) => (
            <div key={g.group} className="mt-5 first:mt-2">
              <p className="mb-1.5 px-3 text-[11px] font-medium tracking-[0.08em] text-slate-400 uppercase">
                {g.group}
              </p>
              <ul className="space-y-0.5">
                {g.items.map((it) => {
                  const href = `${base}/${it.href}`;
                  const active = pathname === href || pathname.startsWith(`${href}/`);
                  const Icon = it.icon;
                  return (
                    <li key={it.href}>
                      <NavLink
                        full={it.href === "settings/whatsapp"}
                        href={href}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-[14px] transition-colors",
                          active
                            ? "bg-slate-100 font-medium text-slate-950"
                            : "text-slate-600 hover:bg-slate-50 hover:text-slate-950",
                        )}
                      >
                        {active ? (
                          <span
                            className="absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full bg-slate-950"
                            aria-hidden
                          />
                        ) : null}
                        <Icon
                          className={cn(
                            "size-[18px] shrink-0",
                            active ? "text-slate-950" : "text-slate-400 group-hover:text-slate-700",
                          )}
                          strokeWidth={1.75}
                          aria-hidden
                        />
                        {it.label}
                        {it.href === "inbox" && unread.data?.conversations ? (
                          <span
                            className="ml-auto grid min-w-5 place-items-center rounded-full bg-slate-950 px-1.5 text-[11px] font-semibold text-white"
                            aria-label={`${unread.data.conversations} unread`}
                          >
                            {unread.data.conversations}
                          </span>
                        ) : null}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="shrink-0 border-t border-slate-200 p-3">
          <div className="flex items-center gap-3 rounded-lg px-2 py-2">
            <span
              className="grid size-9 shrink-0 place-items-center rounded-full bg-slate-950 text-xs font-semibold text-white"
              aria-hidden
            >
              {initials(me.user.name)}
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-sm font-medium text-slate-950">{me.user.name}</span>
              <span className="block truncate text-xs text-slate-500">{me.role.name}</span>
            </span>
            <button
              type="button"
              onClick={logout}
              aria-label="Sign out"
              title="Sign out"
              className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-950"
            >
              <LogOut className="size-4" aria-hidden />
            </button>
          </div>
        </div>
      </aside>

      {open ? (
        <button
          type="button"
          aria-label="Close menu"
          tabIndex={-1}
          className="fixed inset-0 z-30 bg-slate-950/20 backdrop-blur-[2px] lg:hidden"
          onClick={() => setOpen(false)}
        />
      ) : null}

      <div className="flex min-h-dvh min-w-0 flex-col lg:pl-[272px]">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-slate-200 bg-white/85 px-4 backdrop-blur-md sm:px-6 lg:hidden">
          <button
            type="button"
            className="-ml-1 rounded-md p-2 text-slate-700 hover:bg-slate-100"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            aria-controls="app-sidebar"
            aria-expanded={open}
          >
            <Menu className="size-5" aria-hidden />
          </button>
          <span className="truncate text-sm font-semibold text-slate-950">{me.tenant.name}</span>
        </header>
        <VerifyEmailBanner />
        <main
          className={cn(
            "w-full flex-1",
            // The Inbox uses the whole screen (its own panes scroll)
            wide ? "min-w-0" : "mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-10",
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

/**
 * Settings → WhatsApp needs a full page load: its security headers (CSP, opener policy) allow
 * Facebook's sign-in popup, and headers only apply when a document loads.
 */
function NavLink({ full, ...props }: { full: boolean } & ComponentProps<typeof Link>) {
  if (full) {
    const { href, prefetch: _prefetch, replace: _replace, scroll: _scroll, ...rest } = props;
    return <a href={String(href)} {...(rest as AnchorHTMLAttributes<HTMLAnchorElement>)} />;
  }
  return <Link {...props} />;
}

function TenantSwitcher() {
  const me = useMe();
  const router = useRouter();
  const card =
    "flex w-full items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left";
  const mark = (
    <span className="grid size-6 shrink-0 place-items-center rounded-md bg-slate-100 text-[11px] font-semibold text-slate-700">
      {initials(me.tenant.name)}
    </span>
  );
  if (me.memberships.length < 2)
    return (
      <div className={card}>
        {mark}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-950" dir="auto">
          {me.tenant.name}
        </span>
      </div>
    );
  return (
    <label className={cn(card, "relative cursor-pointer hover:border-slate-300")}>
      {mark}
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-950" dir="auto">
        {me.tenant.name}
      </span>
      <ChevronsUpDown className="size-4 text-slate-400" aria-hidden />
      <select
        aria-label="Switch business"
        className="absolute inset-0 cursor-pointer opacity-0"
        value={me.tenant.slug}
        onChange={(e) => router.push(`/t/${e.target.value}/dashboard`)}
      >
        {me.memberships.map((m) => (
          <option key={m.tenantId} value={m.tenantSlug}>
            {m.tenantName}
          </option>
        ))}
      </select>
    </label>
  );
}
