"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  Check,
  CheckCheck,
  Clock,
  FileText,
  Image as ImageIcon,
  MapPin,
  Mic,
  Search,
  Send,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useCan, useMe } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/misc";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { cn } from "@/lib/cn";
import type {
  ChatMessage,
  ConversationDetail,
  ConversationMode,
  ConversationSummary,
  WhatsAppOverview,
} from "./types";

const FILTERS = [
  { key: "open", label: "Open" },
  { key: "human", label: "With staff" },
  { key: "ai", label: "Agent" },
  { key: "unread", label: "Unread" },
  { key: "closed", label: "Closed" },
] as const;
type Filter = (typeof FILTERS)[number]["key"];

const MODE_LABEL: Record<ConversationMode, string> = {
  AI: "Agent",
  HUMAN: "With staff",
  CLOSED: "Closed",
};

const time = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(iso));

function when(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return time(iso);
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 6) return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(d);
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(d);
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(d);
}

function windowLeft(closesAt: string | null): { open: boolean; label: string } {
  if (!closesAt) return { open: false, label: "The customer hasn't written yet" };
  const ms = new Date(closesAt).getTime() - Date.now();
  if (ms <= 0) return { open: false, label: "More than 24 hours since the customer's last message" };
  const h = Math.floor(ms / 3_600_000);
  return {
    open: true,
    label:
      h >= 1 ? `Replies allowed for ${h} h more` : `Replies allowed for ${Math.ceil(ms / 60_000)} min more`,
  };
}

const nameOf = (c: { contactName: string | null; contactPhone: string }) => c.contactName || c.contactPhone;

export function Inbox() {
  const me = useMe();
  const canReply = useCan("chats:reply");
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get("c");
  const [filter, setFilter] = useState<Filter>("open");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const overview = useQuery({ queryKey: ["whatsapp"], queryFn: () => api<WhatsAppOverview>("/whatsapp") });
  const list = useQuery({
    queryKey: ["chats", filter, search],
    queryFn: () =>
      api<{ items: ConversationSummary[] }>(
        `/chats?${new URLSearchParams({ filter, ...(search ? { q: search } : {}) })}`,
      ),
    refetchInterval: 5000,
  });
  const qc = useQueryClient();
  // The sidebar's unread count follows the list
  useEffect(() => {
    if (list.dataUpdatedAt) void qc.invalidateQueries({ queryKey: ["chats-unread"] });
  }, [list.dataUpdatedAt, qc]);
  const select = (id: string | null) => router.replace(id ? `?c=${id}` : "?", { scroll: false });

  const noNumbers = overview.isSuccess && overview.data.numbers.length === 0;
  const items = list.data?.items ?? [];

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] lg:h-dvh">
      {/* Conversation list */}
      <section
        aria-label="Conversations"
        className={cn(
          "flex w-full shrink-0 flex-col border-r border-slate-200 md:w-80 lg:w-[340px]",
          selected ? "hidden md:flex" : "flex",
        )}
      >
        <div className="border-b border-slate-200 px-4 pt-5 pb-3">
          <h1 className="text-xl font-semibold tracking-tight text-slate-950">Inbox</h1>
          <label className="relative mt-3 block">
            <span className="sr-only">Search conversations</span>
            <Search
              className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400"
              aria-hidden
            />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name or number"
              className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pr-3 pl-9 text-sm outline-none focus:border-slate-400 focus:bg-white"
            />
          </label>
          <div className="mt-3 flex gap-1 overflow-x-auto pb-1" role="tablist" aria-label="Filter">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={cn(
                  "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  filter === f.key ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <ul className="flex-1 overflow-y-auto overscroll-contain">
          {list.isLoading ? <li className="p-4 text-sm text-slate-500">Loading…</li> : null}
          {list.isError ? (
            <li className="p-4">
              <Alert>{errorMessage(list.error)}</Alert>
            </li>
          ) : null}
          {noNumbers ? (
            <li className="p-6 text-sm text-slate-500">
              No WhatsApp number is connected.{" "}
              {/* A full page load: that page's security headers allow Facebook sign-in */}
              <a
                className="font-medium text-slate-950 underline"
                href={`/t/${me.tenant.slug}/settings/whatsapp`}
              >
                Connect WhatsApp
              </a>
            </li>
          ) : list.isSuccess && !items.length ? (
            <li className="p-6 text-sm text-slate-500">
              {search
                ? "No conversations match."
                : filter === "open"
                  ? "No conversations yet."
                  : "Nothing here."}
            </li>
          ) : null}
          {items.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => select(c.id)}
                aria-current={selected === c.id ? "true" : undefined}
                className={cn(
                  "flex w-full gap-3 border-b border-slate-100 px-4 py-3 text-left transition-colors",
                  selected === c.id ? "bg-slate-100" : "hover:bg-slate-50",
                )}
              >
                <Avatar name={nameOf(c)} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span
                      className={cn(
                        "truncate text-sm text-slate-950",
                        c.unreadCount ? "font-semibold" : "font-medium",
                      )}
                      dir="auto"
                    >
                      {nameOf(c)}
                    </span>
                    <span
                      className={cn("shrink-0 text-xs", c.unreadCount ? "text-slate-950" : "text-slate-400")}
                    >
                      {when(c.lastMessageAt)}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-500" dir="auto">
                      {c.lastMessagePreview || "—"}
                    </span>
                    {c.unreadCount ? (
                      <span className="grid min-w-5 place-items-center rounded-full bg-slate-950 px-1.5 text-[11px] font-semibold text-white">
                        {c.unreadCount}
                      </span>
                    ) : null}
                  </span>
                  {c.mode !== "AI" ? (
                    <span className="mt-1 inline-block text-[11px] font-medium text-slate-500">
                      {MODE_LABEL[c.mode]}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* Thread */}
      {selected ? (
        <Thread key={selected} id={selected} canReply={canReply} onBack={() => select(null)} />
      ) : (
        <div className="hidden flex-1 place-items-center p-10 text-center md:grid">
          <div>
            <p className="text-sm font-medium text-slate-950">Select a conversation</p>
            <p className="mt-1 text-sm text-slate-500">
              Customers&apos; WhatsApp messages appear here as they arrive.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  const letters =
    name
      .replace(/[^\p{L}\p{N} ]/gu, "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("") || "#";
  return (
    <span
      className="grid size-10 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-700 uppercase"
      aria-hidden
    >
      {letters}
    </span>
  );
}

function Thread({ id, canReply, onBack }: { id: string; canReply: boolean; onBack: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ["chat", id],
    queryFn: () => api<ConversationDetail>(`/chats/${id}`),
    refetchInterval: 5000,
  });
  const messages = useQuery({
    queryKey: ["chat", id, "messages"],
    queryFn: () => api<{ items: ChatMessage[]; hasMore: boolean }>(`/chats/${id}/messages?limit=100`),
    refetchInterval: 3000,
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["chat", id] });
    void qc.invalidateQueries({ queryKey: ["chats"] });
    void qc.invalidateQueries({ queryKey: ["chats-unread"] });
  };

  // Opening a conversation marks it read
  const unread = detail.data?.unreadCount ?? 0;
  useEffect(() => {
    if (!unread) return;
    void api(`/chats/${id}/read`, { method: "POST" }).then(
      () => {
        void qc.invalidateQueries({ queryKey: ["chats"] });
        void qc.invalidateQueries({ queryKey: ["chats-unread"] });
      },
      () => undefined,
    );
  }, [id, unread, qc]);

  const mode = useMutation({
    mutationFn: (m: ConversationMode) => api(`/chats/${id}/mode`, { method: "POST", body: { mode: m } }),
    onSuccess: invalidate,
  });

  const endRef = useRef<HTMLDivElement>(null);
  const count = messages.data?.items.length ?? 0;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [count]);

  const c = detail.data;
  const groups = useMemo(() => {
    const out: { day: string; items: ChatMessage[] }[] = [];
    for (const m of messages.data?.items ?? []) {
      const day = dayLabel(m.createdAt);
      if (out.at(-1)?.day !== day) out.push({ day, items: [] });
      out.at(-1)!.items.push(m);
    }
    return out;
  }, [messages.data]);

  if (detail.isError)
    return (
      <div className="flex-1 p-6">
        <Alert>{errorMessage(detail.error)}</Alert>
      </div>
    );

  return (
    <div className="flex min-w-0 flex-1">
      <section aria-label="Conversation" className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
          <button
            type="button"
            onClick={onBack}
            className="-ml-1 rounded-md p-1.5 text-slate-600 hover:bg-slate-100 md:hidden"
            aria-label="Back to conversations"
          >
            <ArrowLeft className="size-5" aria-hidden />
          </button>
          {c ? <Avatar name={nameOf(c)} /> : null}
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold text-slate-950">
              <bdi>{c ? nameOf(c) : "…"}</bdi>
            </p>
            <p className="truncate text-xs text-slate-500" dir="ltr">
              {c?.contactPhone}
              {c ? ` · to ${c.whatsappNumber.displayNumber}` : ""}
            </p>
          </div>
          {c && canReply ? (
            <div className="flex shrink-0 items-center gap-2">
              <span
                className={cn(
                  "hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium 2xl:inline-flex",
                  c.mode === "AI"
                    ? "bg-slate-100 text-slate-700"
                    : c.mode === "HUMAN"
                      ? "bg-slate-950 text-white"
                      : "bg-slate-100 text-slate-500",
                )}
              >
                {c.mode === "AI" ? (
                  <Bot className="size-3.5" aria-hidden />
                ) : (
                  <UserRound className="size-3.5" aria-hidden />
                )}
                {MODE_LABEL[c.mode]}
              </span>
              {c.mode === "AI" ? (
                <Button
                  variant="secondary"
                  className="h-8 px-3"
                  onClick={() => mode.mutate("HUMAN")}
                  loading={mode.isPending}
                >
                  Take over
                </Button>
              ) : c.mode === "HUMAN" ? (
                <Button
                  variant="secondary"
                  className="h-8 px-3"
                  onClick={() => mode.mutate("AI")}
                  loading={mode.isPending}
                >
                  <span className="sm:hidden">Hand back</span>
                  <span className="hidden sm:inline">Hand back to agent</span>
                </Button>
              ) : null}
              {c.mode !== "CLOSED" ? (
                <Button
                  variant="ghost"
                  className="hidden h-8 px-3 sm:inline-flex"
                  onClick={() => mode.mutate("CLOSED")}
                  disabled={mode.isPending}
                >
                  Close
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  className="h-8 px-3"
                  onClick={() => mode.mutate("AI")}
                  loading={mode.isPending}
                >
                  Reopen
                </Button>
              )}
            </div>
          ) : null}
        </header>

        <div className="flex-1 overflow-y-auto overscroll-contain bg-slate-50/60 px-4 py-5 sm:px-6">
          {messages.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
          {messages.data?.hasMore ? (
            <p className="mb-4 text-center text-xs text-slate-400">Showing the latest 100 messages</p>
          ) : null}
          {groups.map((g) => (
            <div key={g.day}>
              <p className="my-4 text-center text-xs font-medium text-slate-400">{g.day}</p>
              <ul className="space-y-2">
                {g.items.map((m) => (
                  <MessageRow key={m.id} m={m} conversationId={id} />
                ))}
              </ul>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        {c && canReply ? <Composer conversation={c} onSent={invalidate} /> : null}
      </section>

      {c ? <Details c={c} /> : null}
    </div>
  );
}

function MessageRow({ m, conversationId }: { m: ChatMessage; conversationId: string }) {
  if (m.direction === "INTERNAL")
    return (
      <li className="flex justify-center">
        <span className="rounded-full bg-white px-3 py-1 text-xs text-slate-500 ring-1 ring-slate-200">
          {m.text}
        </span>
      </li>
    );
  const out = m.direction === "OUTBOUND";
  return (
    <li className={cn("flex", out ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[min(34rem,85%)] rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed shadow-sm",
          out
            ? "rounded-br-md bg-slate-950 text-white"
            : "rounded-bl-md bg-white text-slate-900 ring-1 ring-slate-200",
        )}
      >
        {out ? (
          <p className={cn("mb-0.5 text-[11px] font-medium", "text-slate-300")}>
            {m.sender === "AI" ? "Agent" : (m.sentByName ?? "Staff")}
          </p>
        ) : null}
        <Body m={m} out={out} conversationId={conversationId} />
        <p
          className={cn(
            "mt-1 flex items-center justify-end gap-1 text-[11px]",
            out ? "text-slate-400" : "text-slate-400",
          )}
        >
          {time(m.sentAt ?? m.createdAt)}
          {out ? <Tick status={m.status} /> : null}
        </p>
        {m.status === "FAILED" ? (
          <p className="mt-1 flex items-start gap-1 text-xs text-red-300">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>Not delivered{m.errorTitle ? `: ${m.errorTitle}` : ""}</span>
          </p>
        ) : null}
        {m.sender === "AI" ? <AgentDetails meta={m.meta} /> : null}
      </div>
    </li>
  );
}

/** For staff only: what the agent's reply was based on (never shown to the customer) */
function AgentDetails({ meta }: { meta: ChatMessage["meta"] }) {
  const sources = meta?.sources ?? [];
  const tools = meta?.tools ?? [];
  if (!sources.length && !tools.length) return null;
  return (
    <div className="mt-2 space-y-0.5 border-t border-white/15 pt-1.5 text-[11px] text-slate-300">
      {sources.length ? (
        <p>From: {sources.map((s) => `${s.title}${s.page ? ` (p. ${s.page})` : ""}`).join(", ")}</p>
      ) : null}
      {tools.map((t, i) => (
        <p key={i}>
          {TOOL_LABEL[t.tool] ?? t.tool}:{" "}
          {t.ok ? "done" : `failed${t.error ? ` (${t.error.replace(/_/g, " ")})` : ""}`}
        </p>
      ))}
    </div>
  );
}

const TOOL_LABEL: Record<string, string> = {
  "appointments.create": "Booked appointment",
  "calendar.book": "Booked in calendar",
  "calendar.find_slots": "Checked free times",
  "calendar.cancel": "Cancelled booking",
  "leads.create": "Saved lead",
};

function Body({ m, out, conversationId }: { m: ChatMessage; out: boolean; conversationId: string }) {
  const media = (Icon: typeof Mic, label: string, note?: string) => (
    <div
      className={cn("flex items-center gap-2 rounded-lg px-2.5 py-2", out ? "bg-white/10" : "bg-slate-50")}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{label}</span>
        {note ? <span className="block text-xs opacity-70">{note}</span> : null}
      </span>
    </div>
  );
  switch (m.type) {
    case "AUDIO":
      return <Voice m={m} out={out} conversationId={conversationId} />;
    case "IMAGE":
    case "STICKER":
      return (
        <>
          {media(ImageIcon, m.type === "STICKER" ? "Sticker" : "Photo", "Previews arrive with media support")}
          {m.text ? (
            <p className="mt-1.5 whitespace-pre-wrap" dir="auto">
              {m.text}
            </p>
          ) : null}
        </>
      );
    case "DOCUMENT":
    case "VIDEO":
      return (
        <>
          {media(
            FileText,
            m.mediaFilename ?? (m.type === "VIDEO" ? "Video" : "Document"),
            "Downloads arrive with media support",
          )}
          {m.text ? (
            <p className="mt-1.5 whitespace-pre-wrap" dir="auto">
              {m.text}
            </p>
          ) : null}
        </>
      );
    case "LOCATION":
      return media(MapPin, m.text ?? "Location");
    case "REACTION":
      return <p className="text-2xl leading-none">{m.text}</p>;
    case "UNSUPPORTED":
      return (
        <p className="text-sm italic opacity-70">
          A message type WhatsApp doesn&apos;t share with businesses
        </p>
      );
    default:
      return (
        <p className="break-words whitespace-pre-wrap" dir="auto">
          {m.text}
        </p>
      );
  }
}

/** A voice note: player, length and what was said (the transcript, or the agent's words) */
function Voice({ m, out, conversationId }: { m: ChatMessage; out: boolean; conversationId: string }) {
  const words = out ? m.text : m.transcript;
  const note = m.meta?.tooLong
    ? "Too long to transcribe"
    : !m.hasMedia
      ? "Processing…"
      : !out && m.transcript === null
        ? "No transcript"
        : null;
  return (
    <div className="min-w-[15rem]">
      <p
        className={cn(
          "mb-1.5 flex items-center gap-1.5 text-xs font-medium",
          out ? "text-slate-300" : "text-slate-500",
        )}
      >
        <Mic className="size-3.5" aria-hidden />
        Voice message{m.mediaSeconds ? ` · ${fmtSeconds(m.mediaSeconds)}` : ""}
        {m.meta?.sentAsText ? " · sent as text" : ""}
      </p>
      {m.hasMedia ? (
        <audio
          controls
          preload="none"
          src={`/api/v1/chats/${conversationId}/messages/${m.id}/media`}
          className="h-9 w-full max-w-72"
          aria-label="Play voice message"
        />
      ) : null}
      {words ? (
        <p className="mt-1.5 text-sm break-words whitespace-pre-wrap opacity-90" dir="auto">
          {out ? words : `“${words}”`}
        </p>
      ) : null}
      {note ? <p className="mt-1 text-xs opacity-70">{note}</p> : null}
    </div>
  );
}

const fmtSeconds = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function Tick({ status }: { status: ChatMessage["status"] }) {
  if (status === "QUEUED") return <Clock className="size-3.5" aria-label="Sending" />;
  if (status === "SENT") return <Check className="size-3.5" aria-label="Sent" />;
  if (status === "DELIVERED") return <CheckCheck className="size-3.5" aria-label="Delivered" />;
  if (status === "READ") return <CheckCheck className="size-3.5 text-sky-400" aria-label="Read" />;
  if (status === "FAILED") return <AlertCircle className="size-3.5 text-red-300" aria-label="Failed" />;
  return null;
}

function Composer({ conversation: c, onSent }: { conversation: ConversationDetail; onSent: () => void }) {
  const [text, setText] = useState("");
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const send = useMutation({
    mutationFn: () => api(`/chats/${c.id}/messages`, { method: "POST", body: { text } }),
    onSuccess: () => {
      setText("");
      onSent();
    },
  });
  const win = windowLeft(c.windowClosesAt);
  const disconnected = c.whatsappNumber.status !== "CONNECTED";
  const blocked = c.mode === "CLOSED" || !win.open || disconnected;
  const submit = () => {
    if (text.trim() && !blocked && !send.isPending) send.mutate();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-slate-200 bg-white px-4 py-3 sm:px-5">
      {send.isError ? (
        <div className="mb-2">
          <Alert>{errorMessage(send.error)}</Alert>
        </div>
      ) : null}
      {blocked ? (
        <p className="py-2 text-sm text-slate-500">
          {disconnected
            ? "This WhatsApp number is disconnected. Reconnect it in Settings → WhatsApp to reply."
            : c.mode === "CLOSED"
              ? "This conversation is closed. It reopens when the customer writes again, or reopen it above."
              : `${win.label}. WhatsApp only allows approved message templates now.`}
        </p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex items-end gap-2"
        >
          <label className="sr-only" htmlFor="reply">
            Reply
          </label>
          <textarea
            id="reply"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            rows={Math.min(6, Math.max(1, text.split("\n").length))}
            maxLength={4096}
            dir="auto"
            placeholder={c.mode === "AI" ? "Reply (you'll take over from the agent)" : "Reply"}
            className="max-h-40 min-h-10 flex-1 resize-none rounded-xl border border-slate-200 px-3.5 py-2.5 text-[14px] outline-none focus:border-slate-400"
          />
          <Button
            type="submit"
            className="h-10 px-3"
            loading={send.isPending}
            disabled={!text.trim()}
            aria-label="Send"
          >
            <Send className="size-4" aria-hidden />
          </Button>
        </form>
      )}
      {!blocked ? (
        <p className="mt-1.5 text-xs text-slate-400">
          {win.label} · Enter to send, Shift+Enter for a new line
        </p>
      ) : null}
    </div>
  );
}

function Details({ c }: { c: ConversationDetail }) {
  const me = useMe();
  const row = (label: string, value: ReactNode) => (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-950">{value}</dd>
    </div>
  );
  return (
    <aside
      aria-label="Contact details"
      className="hidden w-72 shrink-0 overflow-y-auto border-l border-slate-200 p-5 xl:block"
    >
      <p className="text-sm font-semibold text-slate-950">Contact</p>
      <dl className="mt-4 space-y-4">
        {row("Name", <span dir="auto">{c.contactName ?? "—"}</span>)}
        {row("WhatsApp", <span dir="ltr">{c.contactPhone}</span>)}
        {row("Business number", <span dir="ltr">{c.whatsappNumber.displayNumber}</span>)}
        {row(
          "Answered by",
          c.agent?.name ??
            (c.whatsappNumber.agent
              ? `${c.whatsappNumber.agent.name}${c.whatsappNumber.agent.status === "ACTIVE" ? "" : " (not published, so it doesn't answer yet)"}`
              : "No agent assigned"),
        )}
        {row(
          "Lead",
          c.lead ? (
            <Link className="underline" href={`/t/${me.tenant.slug}/leads?lead=${c.lead.id}`}>
              {c.lead.customerName ?? "Open lead"} · {c.lead.status.label}
            </Link>
          ) : (
            "None yet"
          ),
        )}
      </dl>
    </aside>
  );
}
