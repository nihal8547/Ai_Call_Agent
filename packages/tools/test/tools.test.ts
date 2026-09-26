import { createHmac, createVerify } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createToolExecutor,
  eventIdFor,
  type ExecutorDeps,
  type ResultCache,
  type ToolBinding,
  type ToolRunEvent,
} from "../src";
import { clinicContext, fakeGoogle, MemoryBookings, serviceAccount, toolCall } from "./support";

// ── Local receivers ─────────────────────────────────────────────────────────
type Received = { headers: http.IncomingHttpHeaders; body: string };
let webhookUrl = "";
let webhookStatus = 200;
const received: Received[] = [];
const hook = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ headers: req.headers, body });
    if (webhookStatus === 302) res.writeHead(302, { location: "http://169.254.169.254/" }).end();
    else res.writeHead(webhookStatus).end("ok");
  });
});

const mails: { from: string; to: string[]; data: string }[] = [];
const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ["STARTTLS"],
  onAuth(auth, _s, cb) {
    if (auth.username === "bot" && auth.password === "secret-pass") cb(null, { user: "bot" });
    else cb(new Error("Invalid username or password"));
  },
  onData(stream, session, cb) {
    let data = "";
    stream.on("data", (c: Buffer) => (data += c.toString()));
    stream.on("end", () => {
      mails.push({
        from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
        to: session.envelope.rcptTo.map((r) => r.address),
        data,
      });
      cb();
    });
  },
});
let smtpPort = 0;

beforeAll(async () => {
  await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
  webhookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hooks/calls`;
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
  smtpPort = (smtp.server.address() as AddressInfo).port;
});
afterAll(async () => {
  hook.close();
  await new Promise<void>((r) => smtp.close(() => r()));
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function setup(opts: {
  tools: string[];
  bindings?: Partial<Record<string, ToolBinding>>;
  deps?: Partial<ExecutorDeps>;
  patch?: Parameters<typeof clinicContext>[0];
}) {
  const ctx = clinicContext((c) => {
    c.tools = opts.tools as typeof c.tools;
    opts.patch?.(c);
  });
  const bookings = new MemoryBookings();
  const events: ToolRunEvent[] = [];
  const integrationErrors: string[] = [];
  const leads: Record<string, unknown>[] = [];
  const executor = createToolExecutor(ctx, {
    binding: async (tool) => opts.bindings?.[tool] ?? null,
    bookings,
    saveLead: async (c) => {
      leads.push(c);
      return { leadId: "lead-1" };
    },
    onEvent: (e) => events.push(e),
    onIntegrationError: (id, e) => void integrationErrors.push(`${id}:${e.kind}`),
    allowPrivateNetwork: true,
    timeoutMs: 1500,
    ...opts.deps,
  });
  return { ctx, executor, bookings, events, integrationErrors, leads };
}

const memoryCache = (): ResultCache & { store: Map<string, unknown> } => {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async (k) => (store.get(k) as never) ?? null,
    set: async (k, v) => void store.set(k, v),
  };
};

// ── Executor rules ──────────────────────────────────────────────────────────
describe("executor", () => {
  it("never runs a tool the agent was not granted, or one without a connected integration", async () => {
    const { executor, events } = setup({ tools: ["leads.create"] });
    expect(await executor.run(toolCall("webhook.post", {}))).toEqual({
      ok: false,
      error: "tool_not_enabled",
    });
    const granted = setup({ tools: ["webhook.post"] });
    expect(await granted.executor.run(toolCall("webhook.post", {}))).toEqual({
      ok: false,
      error: "not_connected",
    });
    expect(events[0]).toMatchObject({
      tool: "webhook.post",
      ok: false,
      error: "tool_not_enabled",
      attempts: 0,
    });
  });

  it("validates inputs before touching anything", async () => {
    const { executor, bookings } = setup({ tools: ["appointments.create"] });
    expect(await executor.run(toolCall("appointments.create", { date: "", time: "10:00" }))).toEqual({
      ok: false,
      error: "invalid_input",
    });
    expect(bookings.rows).toHaveLength(0);
  });

  it("remembers successful calls so a retried turn never repeats a side effect", async () => {
    const cache = memoryCache();
    const binding: ToolBinding = {
      integrationId: "int-1",
      type: "WEBHOOK",
      config: { url: webhookUrl },
      credentials: { secret: "s".repeat(32) },
    };
    const { executor, events } = setup({
      tools: ["webhook.post"],
      bindings: { "webhook.post": binding },
      deps: { cache },
    });
    received.length = 0;
    const call = toolCall("webhook.post", { stage: "qualified" });
    expect(await executor.run(call)).toEqual({ ok: true });
    expect(await executor.run(call)).toEqual({ ok: true });
    expect(received).toHaveLength(1);
    expect(events.map((e) => e.cached)).toEqual([false, true]);
  });
});

// ── Platform bookings ───────────────────────────────────────────────────────
describe("appointments.create", () => {
  const input = { title: "Cleaning: Priya", date: "2026-09-29", time: "10:00" };

  it("books a free slot, then offers the nearest free times for a taken one", async () => {
    const { executor, bookings } = setup({ tools: ["appointments.create"] });
    expect(await executor.run(toolCall("appointments.create", input))).toMatchObject({
      ok: true,
      data: { appointmentId: "appt-1" },
    });
    const second = {
      ...toolCall("appointments.create", { ...input, title: "Cleaning: Arjun" }),
      idempotencyKey: "call2:book:4",
    };
    const r = await executor.run(second);
    expect(r).toEqual({
      ok: false,
      error: "slot_unavailable",
      message:
        "10 AM on Tuesday, 29 September is already booked. On Tuesday, 29 September I have 9:30 AM or 10:30 AM free.",
      retryFields: ["preferred_time"],
    });
    expect(bookings.rows).toHaveLength(1);
  });

  it("refuses closed hours and dates beyond the booking window, asking again for the date", async () => {
    const { executor } = setup({ tools: ["appointments.create"] });
    const sunday = await executor.run(toolCall("appointments.create", { ...input, date: "2026-10-04" }));
    expect(sunday).toMatchObject({
      ok: false,
      error: "closed",
      retryFields: ["preferred_date", "preferred_time"],
    });
    expect((sunday as { message: string }).message).toContain("We're closed at 10 AM on Sunday, 4 October.");
    const far = await executor.run(toolCall("appointments.create", { ...input, date: "2027-03-01" }));
    expect(far).toMatchObject({ ok: false, error: "too_far" });
  });

  it("a restaurant with capacity takes several bookings at the same time", async () => {
    const { executor, bookings } = setup({
      tools: ["appointments.create"],
      patch: (c) => void (c.appointment = { ...c.appointment!, capacity: 2 }),
    });
    for (const key of ["a", "b", "c"]) {
      await executor.run({
        ...toolCall("appointments.create", { ...input, title: `Table ${key}` }),
        idempotencyKey: key,
      });
    }
    expect(bookings.rows).toHaveLength(2);
  });
});

// ── Google Calendar & Sheets ────────────────────────────────────────────────
describe("Google tools", () => {
  const sa = serviceAccount();
  const calendar: ToolBinding = {
    integrationId: "cal-1",
    type: "GOOGLE_CALENDAR",
    config: { calendarId: "clinic@group.calendar.google.com" },
    credentials: sa.credentials,
  };
  const bookInput = { title: "Cleaning: Priya", date: "2026-09-29", time: "10:00" };
  const busyAt10 = {
    items: [
      {
        id: "x",
        status: "confirmed",
        start: { dateTime: "2026-09-29T10:00:00+05:30" },
        end: { dateTime: "2026-09-29T10:30:00+05:30" },
      },
    ],
  };
  const withCalendar = (tools: string[], google: ReturnType<typeof fakeGoogle>) =>
    setup({
      tools,
      bindings: { "calendar.book": calendar, "calendar.find_slots": calendar, "calendar.cancel": calendar },
      deps: { fetch: google.fetch },
      patch: (c) => {
        const book = c.workflow.steps.find((s) => s.id === "book")!;
        if (book.type === "confirm_and_act") book.action = "calendar.book";
      },
    });

  it("signs a service-account JWT that Google can verify", async () => {
    const google = fakeGoogle([
      (r) => (r.url.pathname.endsWith("/events") ? { status: 200, json: { items: [] } } : undefined),
    ]);
    const { executor } = withCalendar(["calendar.find_slots"], google);
    await executor.run(toolCall("calendar.find_slots", { date: "2026-09-29" }, "slots"));
    const token = google.requests.find((r) => r.url.href === "https://oauth2.googleapis.com/token")!;
    const assertion = new URLSearchParams(token.body).get("assertion")!;
    const [h, c, sig] = assertion.split(".");
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(sa.publicKey, sig!, "base64url")).toBe(true);
    expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toMatchObject({
      iss: "bot@project.iam.gserviceaccount.com",
      aud: "https://oauth2.googleapis.com/token",
    });
  });

  it("find_slots reads the calendar and offers times spread over the day", async () => {
    const google = fakeGoogle([
      (r) => (r.url.pathname.endsWith("/events") ? { status: 200, json: busyAt10 } : undefined),
    ]);
    const { executor } = withCalendar(["calendar.find_slots"], google);
    const r = await executor.run(toolCall("calendar.find_slots", { date: "2026-09-29" }, "slots"));
    expect(r).toMatchObject({ ok: true, message: "On Tuesday, 29 September I have 9 AM or 6:30 PM free." });
    expect((r as { data: { slots: string[] } }).data.slots).not.toContain("10:00");
    const list = google.requests.find((x) => x.url.pathname.endsWith("/events"))!;
    expect(list.headers.get("authorization")).toBe("Bearer ya29.test-token");
    expect(list.url.pathname).toBe("/calendar/v3/calendars/clinic%40group.calendar.google.com/events");
  });

  it("book creates the event with a deterministic id and records the appointment", async () => {
    const google = fakeGoogle([
      (r) =>
        r.method === "GET" && r.url.pathname.endsWith("/events")
          ? { status: 200, json: { items: [] } }
          : undefined,
      (r) =>
        r.method === "POST" && r.url.pathname.endsWith("/events")
          ? { status: 200, json: { id: JSON.parse(r.body).id } }
          : undefined,
    ]);
    const { executor, bookings, ctx } = withCalendar(["calendar.book"], google);
    const call = toolCall("calendar.book", bookInput);
    const r = await executor.run(call);
    const eventId = eventIdFor(`${ctx.tenantId}:${call.idempotencyKey}`);
    expect(r).toEqual({ ok: true, data: { appointmentId: "appt-1", eventId } });
    const insert = JSON.parse(
      google.requests.find((x) => x.method === "POST" && x.url.pathname.endsWith("/events"))!.body,
    );
    expect(insert).toMatchObject({
      id: eventId,
      summary: "Cleaning: Priya",
      start: { dateTime: "2026-09-29T04:30:00.000Z", timeZone: "Asia/Kolkata" },
      end: { dateTime: "2026-09-29T05:00:00.000Z" },
    });
    expect(insert.description).toContain("Patient name: Priya");
    expect(eventId).toMatch(/^[0-9a-v]{5,1024}$/);
    expect(bookings.rows[0]).toMatchObject({ externalRef: eventId, integrationId: "cal-1" });
  });

  it("book offers alternatives when the calendar is busy, and undoes the reservation when Google fails", async () => {
    const busy = fakeGoogle([
      (r) => (r.url.pathname.endsWith("/events") ? { status: 200, json: busyAt10 } : undefined),
    ]);
    const a = withCalendar(["calendar.book"], busy);
    expect(await a.executor.run(toolCall("calendar.book", bookInput))).toMatchObject({
      ok: false,
      error: "slot_unavailable",
      retryFields: ["preferred_time"],
    });

    const failing = fakeGoogle([
      (r) => (r.method === "GET" ? { status: 200, json: { items: [] } } : undefined),
      (r) =>
        r.method === "POST" ? { status: 503, json: { error: { message: "backend error" } } } : undefined,
    ]);
    const b = withCalendar(["calendar.book"], failing);
    expect(await b.executor.run(toolCall("calendar.book", bookInput))).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(b.bookings.rows).toHaveLength(0);
    expect(b.events.at(-1)).toMatchObject({
      attempts: 2,
      detail: "Creating the event failed: backend error",
    });
  });

  it("revoked access marks the integration as needing attention (and is not retried)", async () => {
    const revoked = fakeGoogle([
      (r) =>
        r.url.pathname.endsWith("/events")
          ? { status: 401, json: { error: { message: "Invalid Credentials" } } }
          : undefined,
    ]);
    const { executor, integrationErrors, events } = withCalendar(["calendar.find_slots"], revoked);
    expect(await executor.run(toolCall("calendar.find_slots", { date: "2026-09-29" }, "slots"))).toEqual({
      ok: false,
      error: "integration_error",
    });
    expect(integrationErrors).toEqual(["cal-1:auth"]);
    expect(events.at(-1)!.attempts).toBe(1);
  });

  it("a hanging calendar times out and the call moves on", async () => {
    const hanging = {
      fetch: ((_u: unknown, init: RequestInit) =>
        new Promise((_, reject) =>
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })),
          ),
        )) as typeof fetch,
    };
    const { executor } = withCalendar(["calendar.find_slots"], { ...hanging, requests: [] } as never);
    const started = Date.now();
    expect(await executor.run(toolCall("calendar.find_slots", { date: "2026-09-29" }, "slots"))).toEqual({
      ok: false,
      error: "timeout",
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("cancel removes the caller's next appointment from the calendar", async () => {
    const google = fakeGoogle([(r) => (r.method === "DELETE" ? { status: 204 } : undefined)]);
    const { executor, bookings } = withCalendar(["calendar.cancel"], google);
    await bookings.book({
      start: new Date("2026-09-30T05:30:00Z"),
      end: new Date("2026-09-30T06:00:00Z"),
      title: "Visit",
      capacity: null,
      bufferMinutes: 0,
      externalRef: "apabc",
      integrationId: "cal-1",
      collected: {},
    });
    const r = await executor.run(toolCall("calendar.cancel", {}, "cancel"));
    expect(r).toMatchObject({
      ok: true,
      message: "I've cancelled your appointment on Wednesday, 30 September at 11 AM.",
    });
    expect(google.requests.find((x) => x.method === "DELETE")!.url.pathname).toMatch(/\/events\/apabc$/);
    expect(bookings.rows[0]!.status).toBe("CANCELLED");
    expect(
      await executor.run({ ...toolCall("calendar.cancel", {}, "cancel"), idempotencyKey: "other" }),
    ).toMatchObject({ ok: false, error: "no_appointment" });
  });

  it("sheets appends a RAW row so caller answers can never become formulas", async () => {
    const google = fakeGoogle([
      (r) =>
        r.url.pathname.includes(":append")
          ? { status: 200, json: { updates: { updatedRange: "Leads!A2:F2" } } }
          : undefined,
    ]);
    const binding: ToolBinding = {
      integrationId: "sh-1",
      type: "GOOGLE_SHEETS",
      config: { spreadsheetId: "1AbCdEfGhIjKlMnOpQrStUvWxYz", sheetName: "Leads" },
      credentials: sa.credentials,
    };
    const { executor } = setup({
      tools: ["sheets.append_row"],
      bindings: { "sheets.append_row": binding },
      deps: { fetch: google.fetch },
    });
    const call = toolCall("sheets.append_row", {});
    call.input.collected = { patient_name: '=HYPERLINK("http://evil")', service_required: "Cleaning" };
    expect(await executor.run(call)).toEqual({ ok: true });
    const req = google.requests.find((x) => x.url.pathname.includes(":append"))!;
    expect(req.url.searchParams.get("valueInputOption")).toBe("RAW");
    expect(decodeURIComponent(req.url.pathname)).toContain("'Leads'!A1:append");
    expect(JSON.parse(req.body).values[0]).toEqual([
      "2026-09-28 11:30",
      "+919876543210",
      '=HYPERLINK("http://evil")',
      "Cleaning",
      "",
      "",
      "",
    ]);
  });
});

// ── Webhooks ────────────────────────────────────────────────────────────────
describe("webhook.post", () => {
  const secret = "whsec_0123456789abcdef";
  const binding = (): ToolBinding => ({
    integrationId: "wh-1",
    type: "WEBHOOK",
    config: { url: webhookUrl },
    credentials: { secret },
  });

  it("posts the call's details with a verifiable HMAC signature and idempotency key", async () => {
    received.length = 0;
    webhookStatus = 200;
    const { executor } = setup({ tools: ["webhook.post"], bindings: { "webhook.post": binding() } });
    expect(await executor.run(toolCall("webhook.post", { stage: "qualified" }, "notify"))).toEqual({
      ok: true,
    });
    const { headers, body } = received[0]!;
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(headers["x-platform-signature"]))!;
    expect(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")).toBe(v1);
    expect(headers["idempotency-key"]).toBe("call:notify:4");
    expect(JSON.parse(body)).toMatchObject({
      event: "call.tool",
      stepId: "notify",
      data: { stage: "qualified" },
      collected: { patient_name: "Priya" },
    });
  });

  it("does not follow redirects, reports failures, and never reaches private networks in production", async () => {
    webhookStatus = 302;
    const a = setup({ tools: ["webhook.post"], bindings: { "webhook.post": binding() } });
    expect(await a.executor.run(toolCall("webhook.post", {}))).toEqual({
      ok: false,
      error: "integration_error",
    });
    webhookStatus = 500;
    const b = setup({ tools: ["webhook.post"], bindings: { "webhook.post": binding() } });
    expect(await b.executor.run(toolCall("webhook.post", {}))).toEqual({ ok: false, error: "unavailable" });
    expect(b.events.at(-1)!.attempts).toBe(1); // side effect: not retried blindly
    webhookStatus = 200;
    received.length = 0;
    const c = setup({
      tools: ["webhook.post"],
      bindings: { "webhook.post": binding() },
      deps: { allowPrivateNetwork: false },
    });
    expect(await c.executor.run(toolCall("webhook.post", {}))).toEqual({ ok: false, error: "blocked" });
    expect(received).toHaveLength(0);
    // …including IPv6 literals and the cloud metadata address
    for (const url of ["http://[::1]:9/x", "http://169.254.169.254/latest/meta-data"]) {
      const d = setup({
        tools: ["webhook.post"],
        bindings: { "webhook.post": { ...binding(), config: { url } } },
        deps: { allowPrivateNetwork: false },
      });
      expect(await d.executor.run(toolCall("webhook.post", {}))).toEqual({ ok: false, error: "blocked" });
    }
  });
});

// ── Email ───────────────────────────────────────────────────────────────────
describe("email.send", () => {
  const binding = (password = "secret-pass"): ToolBinding => ({
    integrationId: "mail-1",
    type: "EMAIL_SMTP",
    config: {
      from: "agent@clinic.test",
      fromName: "Clinic\r\nBcc: victim@evil.test",
      defaultTo: ["frontdesk@clinic.test"],
    },
    credentials: { host: "127.0.0.1", port: smtpPort, secure: false, username: "bot", password },
  });

  it("sends a summary to the default recipients without header injection", async () => {
    mails.length = 0;
    const { executor } = setup({ tools: ["email.send"], bindings: { "email.send": binding() } });
    const call = toolCall("email.send", { subject: "New patient\r\nBcc: victim@evil.test" });
    call.input.collected = { patient_name: "Priya", urgency: "Emergency" };
    expect(await executor.run(call)).toEqual({ ok: true });
    expect(mails[0]!.to).toEqual(["frontdesk@clinic.test"]);
    expect(mails[0]!.data).toContain("Subject: New patient Bcc: victim@evil.test");
    expect(mails[0]!.data).not.toMatch(/^Bcc:/m);
    expect(mails[0]!.data).toContain("Patient name: Priya");
    expect(mails[0]!.data).toContain("Urgency: Emergency");
  });

  it("wrong password marks the integration for attention", async () => {
    const { executor, integrationErrors } = setup({
      tools: ["email.send"],
      bindings: { "email.send": binding("wrong") },
    });
    expect(await executor.run(toolCall("email.send", {}))).toEqual({ ok: false, error: "integration_error" });
    expect(integrationErrors).toEqual(["mail-1:auth"]);
  });
});
