import type { ToolCall } from "@platform/core";
import { AgentConfig } from "@platform/shared";
import { instantiateTemplate } from "@platform/templates";
import { generateKeyPairSync } from "node:crypto";
import type { BookingStore, Interval, ToolContext } from "../src";

/** Monday 28 Sep 2026, 11:30 in India */
export const NOW = new Date("2026-09-28T06:00:00Z");

export function clinicContext(patch: (c: AgentConfig) => void = () => undefined): ToolContext {
  const config = AgentConfig.parse(instantiateTemplate("clinic-reception"));
  patch(config);
  return {
    tenantId: "00000000-0000-4000-8000-000000000001",
    callId: "00000000-0000-4000-8000-000000000002",
    agentId: "00000000-0000-4000-8000-000000000003",
    callerNumber: "+919876543210",
    timezone: "Asia/Kolkata",
    config,
    now: NOW,
  };
}

export function toolCall(tool: ToolCall["tool"], input: Record<string, unknown>, stepId = "book"): ToolCall {
  return {
    tool,
    input: { collected: { patient_name: "Priya" }, ...input },
    stepId,
    background: false,
    idempotencyKey: `call:${stepId}:4`,
  };
}

/** In-memory appointment book with the same contract as the API's Postgres store */
export class MemoryBookings implements BookingStore {
  rows: {
    id: string;
    start: Date;
    end: Date;
    externalRef?: string;
    integrationId?: string;
    status: string;
    title: string;
  }[] = [];

  async busy(from: Date, to: Date): Promise<Interval[]> {
    return this.rows
      .filter((r) => r.status === "UPCOMING" && r.start < to && r.end > from)
      .map((r) => ({ start: r.start, end: r.end }));
  }
  async book(a: Parameters<BookingStore["book"]>[0]) {
    const existing = this.rows.find(
      (r) => r.start.getTime() === a.start.getTime() && r.title === a.title && r.status === "UPCOMING",
    );
    if (existing) return { ok: true as const, appointmentId: existing.id };
    if (a.capacity !== null) {
      const buf = a.bufferMinutes * 60_000;
      const overlapping = this.rows.filter(
        (r) =>
          r.status === "UPCOMING" &&
          r.start.getTime() < a.end.getTime() + buf &&
          r.end.getTime() > a.start.getTime() - buf,
      ).length;
      if (overlapping >= a.capacity) return { ok: false as const };
    }
    const id = `appt-${this.rows.length + 1}`;
    this.rows.push({
      id,
      start: a.start,
      end: a.end,
      title: a.title,
      status: "UPCOMING",
      ...(a.externalRef ? { externalRef: a.externalRef } : {}),
      ...(a.integrationId ? { integrationId: a.integrationId } : {}),
    });
    return { ok: true as const, appointmentId: id };
  }
  async discard(id: string) {
    this.rows = this.rows.filter((r) => r.id !== id);
  }
  async nextForCaller() {
    const r = this.rows
      .filter((x) => x.status === "UPCOMING")
      .sort((a, b) => a.start.getTime() - b.start.getTime())[0];
    return r
      ? {
          id: r.id,
          start: r.start,
          externalRef: r.externalRef ?? null,
          integrationId: r.integrationId ?? null,
        }
      : null;
  }
  async cancel(id: string) {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.status = "CANCELLED";
  }
}

export function serviceAccount() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    credentials: {
      kind: "service_account" as const,
      clientEmail: "bot@project.iam.gserviceaccount.com",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    },
    publicKey,
  };
}

type Route = (req: {
  method: string;
  url: URL;
  body: string;
  headers: Headers;
}) => { status: number; json?: unknown } | undefined;

/** A fake Google: token endpoint + whatever routes a test adds. Records every request. */
export function fakeGoogle(routes: Route[]) {
  const requests: { method: string; url: URL; body: string; headers: Headers }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body = typeof init.body === "string" ? init.body : init.body ? String(init.body) : "";
    const req = { method: init.method ?? "GET", url, body, headers: new Headers(init.headers) };
    requests.push(req);
    if (url.href === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "ya29.test-token", expires_in: 3600 });
    }
    for (const r of routes) {
      const out = r(req);
      if (out)
        return out.status === 204
          ? new Response(null, { status: 204 })
          : Response.json(out.json ?? {}, { status: out.status });
    }
    return Response.json(
      { error: { message: `no route for ${req.method} ${url.pathname}` } },
      { status: 404 },
    );
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}
