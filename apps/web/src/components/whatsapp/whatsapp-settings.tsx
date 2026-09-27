"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useCan, useMe } from "@/components/app/me-context";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField, TextField } from "@/components/ui/field";
import { Alert, Card, PageHeader } from "@/components/ui/misc";
import { StatusPill } from "@/components/ui/status-pill";
import { api } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { fmtDateTime } from "@/lib/format";
import type { AgentListItem } from "@/lib/types";
import { embeddedSignup } from "./facebook";
import type { WhatsAppNumber, WhatsAppOverview } from "./types";

const QUALITY: Record<string, string> = { GREEN: "High", YELLOW: "Medium", RED: "Low" };

export function WhatsAppSettingsPage() {
  const me = useMe();
  const canManage = useCan("chats:manage");
  const qc = useQueryClient();
  const overview = useQuery({ queryKey: ["whatsapp"], queryFn: () => api<WhatsAppOverview>("/whatsapp") });
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ items: AgentListItem[] }>("/agents"),
    enabled: canManage,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["whatsapp"] });
  const [manual, setManual] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [connected, setConnected] = useState<string | null>(null);

  const facebook = useMutation({
    mutationFn: async () => {
      const p = overview.data!.platform;
      const r = await embeddedSignup({
        appId: p.appId!,
        configId: p.configId!,
        graphVersion: p.graphVersion,
      });
      return api<WhatsAppNumber>("/whatsapp/connect/embedded-signup", {
        method: "POST",
        body: { ...r, agentId: agentId || null },
      });
    },
    onSuccess: (n) => {
      setConnected(n.displayNumber);
      void refresh();
    },
  });

  const platform = overview.data?.platform;
  const numbers = overview.data?.numbers ?? [];
  const agentList = agents.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="WhatsApp"
        description="Connect your WhatsApp Business number. Customers' messages appear in the Inbox."
        actions={
          numbers.length ? (
            <Link
              href={`/t/${me.tenant.slug}/inbox`}
              className="inline-flex h-10 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-50"
            >
              Open Inbox
            </Link>
          ) : null
        }
      />
      {overview.isError ? <Alert>{errorMessage(overview.error)}</Alert> : null}
      {connected ? (
        <div className="mb-6">
          <Alert tone="success">{connected} is connected. Messages to it now appear in the Inbox.</Alert>
        </div>
      ) : null}

      {numbers.length ? (
        <div className="mb-8 space-y-4">
          {numbers.map((n) => (
            <NumberCard key={n.id} number={n} agents={agentList} canManage={canManage} onChanged={refresh} />
          ))}
        </div>
      ) : null}

      {canManage && platform ? (
        <Card className="p-6 sm:p-8">
          <div className="flex items-start gap-4">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-slate-950 text-white">
              <MessageCircle className="size-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold text-slate-950">
                {numbers.length ? "Connect another number" : "Connect your WhatsApp Business number"}
              </h2>
              <p className="mt-1 max-w-2xl text-[15px] text-slate-500">
                You&apos;ll sign in with Facebook, choose or create your WhatsApp Business account and verify
                the number with a code. It uses the official WhatsApp Business API.
              </p>
              <ul className="mt-4 space-y-1.5 text-sm text-slate-600">
                <li>
                  • A number that isn&apos;t in use on the WhatsApp or WhatsApp Business app (delete it there
                  first).
                </li>
                <li>• A Facebook account that can manage your business in Meta Business Suite.</li>
              </ul>

              <div className="mt-6 grid max-w-xl gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
                <SelectField label="Answered by" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                  <option value="">Choose later</option>
                  {agentList.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.status !== "ACTIVE" ? " (not published)" : ""}
                    </option>
                  ))}
                </SelectField>
                <Button
                  onClick={() => facebook.mutate()}
                  loading={facebook.isPending}
                  disabled={!platform.embeddedSignup}
                >
                  Continue with Facebook
                </Button>
              </div>
              {!platform.embeddedSignup ? (
                <p className="mt-3 text-sm text-amber-700">
                  Facebook sign-in isn&apos;t set up on this platform yet (the operator adds the Meta app).
                  You can still connect with an access token below.
                </p>
              ) : null}
              {facebook.isError ? (
                <div className="mt-4">
                  <Alert>
                    {facebook.error instanceof ApiError
                      ? errorMessage(facebook.error)
                      : facebook.error.message}
                  </Alert>
                </div>
              ) : null}
              {!platform.webhookReady ? (
                <div className="mt-4">
                  <Alert tone="info">
                    The platform&apos;s WhatsApp webhook isn&apos;t configured yet, so incoming messages
                    won&apos;t arrive. Ask the platform operator to finish the Meta app setup.
                  </Alert>
                </div>
              ) : null}

              <button
                type="button"
                onClick={() => setManual((v) => !v)}
                className="mt-6 text-sm font-medium text-slate-700 underline-offset-4 hover:underline"
                aria-expanded={manual}
              >
                {manual ? "Hide other ways to connect" : "Other ways to connect: access token"}
              </button>
              {manual ? (
                <ManualConnect
                  agents={agentList}
                  webhookUrl={platform.webhookUrl}
                  onConnected={(n) => {
                    setConnected(n.displayNumber);
                    setManual(false);
                    void refresh();
                  }}
                />
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}
      {!canManage && !numbers.length && overview.isSuccess ? (
        <Card>
          <p className="text-sm text-slate-500">
            No WhatsApp number is connected. Ask the business owner to connect one.
          </p>
        </Card>
      ) : null}
    </>
  );
}

function NumberCard({
  number: n,
  agents,
  canManage,
  onChanged,
}: {
  number: WhatsAppNumber;
  agents: AgentListItem[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const assign = useMutation({
    mutationFn: (agentId: string | null) =>
      api(`/whatsapp/numbers/${n.id}`, { method: "PATCH", body: { agentId } }),
    onSuccess: onChanged,
  });
  const register = useMutation({
    mutationFn: () => api(`/whatsapp/numbers/${n.id}/register`, { method: "POST" }),
    onSuccess: onChanged,
  });
  const disconnect = useMutation({
    mutationFn: () => api(`/whatsapp/numbers/${n.id}`, { method: "DELETE" }),
    onSuccess: () => {
      setConfirming(false);
      onChanged();
    },
  });

  return (
    <Card>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-slate-950" dir="ltr">
              {n.displayNumber}
            </h2>
            <StatusPill value={n.status} label={n.status === "PENDING" ? "Needs attention" : undefined} />
          </div>
          <p className="mt-0.5 text-sm text-slate-500" dir="auto">
            {n.verifiedName ?? "WhatsApp Business"} · connected {fmtDateTime(n.connectedAt)}
            {n.qualityRating ? ` · quality ${QUALITY[n.qualityRating] ?? n.qualityRating}` : ""}
          </p>
        </div>
        {canManage ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            {n.status === "PENDING" ? (
              <Button onClick={() => register.mutate()} loading={register.isPending}>
                Finish registration
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => setTesting(true)}>
              Send test message
            </Button>
            <Button variant="ghost" className="text-red-600" onClick={() => setConfirming(true)}>
              Disconnect
            </Button>
          </div>
        ) : null}
      </div>

      {n.lastError ? (
        <div className="mt-4">
          <Alert>{n.lastError}</Alert>
        </div>
      ) : null}
      {register.isError ? (
        <div className="mt-4">
          <Alert>{errorMessage(register.error)}</Alert>
        </div>
      ) : null}

      <div className="mt-5 max-w-sm">
        {canManage ? (
          <SelectField
            label="Answered by"
            value={n.agent?.id ?? ""}
            disabled={assign.isPending}
            onChange={(e) => assign.mutate(e.target.value || null)}
          >
            <option value="">Nobody yet (messages wait in the Inbox)</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.status !== "ACTIVE" ? " (not published)" : ""}
              </option>
            ))}
          </SelectField>
        ) : (
          <p className="text-sm text-slate-600">Answered by {n.agent?.name ?? "nobody yet"}</p>
        )}
        {assign.isError ? <p className="mt-1 text-sm text-red-600">{errorMessage(assign.error)}</p> : null}
        <p className="mt-2 text-xs text-slate-500">
          The agent answers customers on its own, using its questions, knowledge and tools. Take over any
          conversation from the Inbox.
        </p>
      </div>

      <TestDialog open={testing} number={n} onClose={() => setTesting(false)} />
      <Dialog open={confirming} onClose={() => setConfirming(false)} title={`Disconnect ${n.displayNumber}?`}>
        <p className="text-sm text-slate-600">
          Messages to this number stop arriving here and nobody can reply from the Inbox. Past conversations
          stay. You can connect it again later.
        </p>
        {disconnect.isError ? (
          <div className="mt-3">
            <Alert>{errorMessage(disconnect.error)}</Alert>
          </div>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => disconnect.mutate()} loading={disconnect.isPending}>
            Disconnect
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}

function TestDialog({
  open,
  number,
  onClose,
}: {
  open: boolean;
  number: WhatsAppNumber;
  onClose: () => void;
}) {
  const [to, setTo] = useState("");
  const send = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; message: string }>(`/whatsapp/numbers/${number.id}/test`, {
        method: "POST",
        body: { to },
      }),
  });
  const fieldError =
    send.error instanceof ApiError ? send.error.fieldErrors.find((e) => e.path === "to")?.message : undefined;
  return (
    <Dialog
      open={open}
      onClose={() => {
        send.reset();
        onClose();
      }}
      title="Send a test message"
    >
      <p className="mb-4 text-sm text-slate-600">
        Sends WhatsApp&apos;s standard &quot;Hello World&quot; message from {number.displayNumber}. It works
        even if the phone hasn&apos;t written to you before.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send.mutate();
        }}
      >
        <TextField
          label="Send to"
          placeholder="+974 5512 3456"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          error={fieldError}
          inputMode="tel"
          required
        />
        {send.data ? (
          <div className="mt-3">
            <Alert tone={send.data.ok ? "success" : "error"}>{send.data.message}</Alert>
          </div>
        ) : null}
        {send.isError && !fieldError ? (
          <div className="mt-3">
            <Alert>{errorMessage(send.error)}</Alert>
          </div>
        ) : null}
        <div className="mt-6 flex justify-end">
          <Button type="submit" loading={send.isPending}>
            Send
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ManualConnect({
  agents,
  webhookUrl,
  onConnected,
}: {
  agents: AgentListItem[];
  webhookUrl: string;
  onConnected: (n: WhatsAppNumber) => void;
}) {
  const [form, setForm] = useState({ accessToken: "", wabaId: "", phoneNumberId: "", agentId: "" });
  const connect = useMutation({
    mutationFn: () =>
      api<WhatsAppNumber>("/whatsapp/connect/manual", {
        method: "POST",
        body: { ...form, agentId: form.agentId || null },
      }),
    onSuccess: onConnected,
  });
  const err = (path: string) =>
    connect.error instanceof ApiError
      ? connect.error.fieldErrors.find((e) => e.path === path)?.message
      : undefined;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <form
      className="mt-4 max-w-xl space-y-4 rounded-lg border border-slate-200 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        connect.mutate();
      }}
    >
      <p className="text-sm text-slate-600">
        For businesses with their own Meta app: in Meta Business Settings create a System User with the
        whatsapp_business_messaging and whatsapp_business_management permissions and generate a permanent
        token. The ids are on the WhatsApp → API Setup page of your Meta app.
      </p>
      <TextField
        label="Permanent access token"
        type="password"
        autoComplete="off"
        value={form.accessToken}
        onChange={set("accessToken")}
        error={err("accessToken")}
        required
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="WhatsApp Business account ID"
          inputMode="numeric"
          value={form.wabaId}
          onChange={set("wabaId")}
          error={err("wabaId")}
          required
        />
        <TextField
          label="Phone number ID"
          inputMode="numeric"
          value={form.phoneNumberId}
          onChange={set("phoneNumberId")}
          error={err("phoneNumberId")}
          required
        />
      </div>
      <SelectField label="Answered by" value={form.agentId} onChange={set("agentId")}>
        <option value="">Choose later</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </SelectField>
      <p className="text-xs text-slate-500">
        Messages reach this platform through its webhook:{" "}
        <span className="font-mono break-all">{webhookUrl}</span>
      </p>
      {connect.isError && !(connect.error instanceof ApiError && connect.error.fieldErrors.length) ? (
        <Alert>{errorMessage(connect.error)}</Alert>
      ) : null}
      <Button type="submit" loading={connect.isPending}>
        Connect
      </Button>
    </form>
  );
}
