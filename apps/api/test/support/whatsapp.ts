import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createHmac } from "node:crypto";
import { vi } from "vitest";

/** Meta ids unique per run: the test database outlives runs, and ids are unique platform-wide */
export const metaId = () => String(1e11 + Math.floor(Math.random() * 9e11));

export type GraphCall = { method: string; path: string; body: Record<string, unknown> | null; auth: string };

/**
 * Meta's Graph API behind fetch: every business token works, the given WABA owns the given
 * numbers, messages get ids, received media can be downloaded and files uploaded. Optionally
 * Gemini too (`gemini`). Everything else goes to the real network.
 */
export function fakeGraph(
  numbers: Record<string, string[]>,
  gemini?: (body: Record<string, unknown>) => Response | Promise<Response>,
) {
  const calls: GraphCall[] = [];
  /** Files customers "sent": media id → bytes (and their type) */
  const media = new Map<string, Buffer>();
  const mediaTypes = new Map<string, string>();
  /** Meta's side of each account: whose webhooks go where, which numbers are registered … */
  const state = {
    appId: "1234567890",
    subscribed: new Set<string>(),
    /** Numbers added to an account but not registered for the Cloud API */
    unregistered: new Set<string>(),
    /** A two-step PIN the owner set: registering needs it */
    pins: new Map<string, string>(),
    revokedTokens: new Set<string>(),
    templates: [] as Record<string, unknown>[],
  };
  /** Files the platform uploaded to Meta */
  const uploads: { id: string; bytes: Buffer; type: string }[] = [];
  let sent = 0;
  const run = metaId();
  const realFetch = globalThis.fetch;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "generativelanguage.googleapis.com" && gemini)
      return gemini(JSON.parse(String(init.body)) as Record<string, unknown>);
    if (url.hostname === "lookaside.test") {
      const file = media.get(url.pathname.slice(1));
      return file
        ? new Response(new Uint8Array(file), { status: 200 })
        : new Response("gone", { status: 404 });
    }
    if (url.hostname !== "graph.facebook.com") return realFetch(input, init);
    const method = init.method ?? "GET";
    const path = url.pathname.replace(/^\/v\d+\.\d/, "");
    if (init.body instanceof FormData) {
      const file = init.body.get("file") as Blob;
      const id = `UPLOADED-${uploads.length + 1}`;
      uploads.push({ id, bytes: Buffer.from(await file.arrayBuffer()), type: String(init.body.get("type")) });
      calls.push({ method, path, body: { upload: id }, auth: "" });
      return json({ id });
    }
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const auth = String((init.headers as Record<string, string>)?.authorization ?? "");
    calls.push({ method, path, body, auth });
    if (path === "/oauth/access_token")
      return json({ access_token: `biz-token-es-${url.searchParams.get("code")}` });
    if (state.revokedTokens.has(auth.replace("Bearer ", "")))
      return json(
        { error: { code: 190, message: "Error validating access token: The session has been invalidated." } },
        401,
      );
    const subs = /^\/(\d+)\/subscribed_apps$/.exec(path);
    if (subs) {
      if (method === "POST") state.subscribed.add(subs[1]!);
      if (method === "DELETE") state.subscribed.delete(subs[1]!);
      if (method !== "GET") return json({ success: true });
      return json({
        data: state.subscribed.has(subs[1]!)
          ? [{ whatsapp_business_api_data: { id: state.appId, name: "Platform" } }]
          : [],
      });
    }
    const reg = /^\/(\d+)\/register$/.exec(path);
    if (reg) {
      const pin = state.pins.get(reg[1]!);
      if (pin && body?.pin !== pin)
        return json({ error: { code: 133005, message: "Two step verification PIN Mismatch" } }, 400);
      state.unregistered.delete(reg[1]!);
      state.pins.set(reg[1]!, String(body?.pin));
      return json({ success: true });
    }
    if (/^\/\d+\/message_templates$/.test(path)) return json({ data: state.templates });
    const waba = Object.keys(numbers).find((w) => path === `/${w}/phone_numbers`);
    if (waba) return json({ data: numbers[waba]!.map((id) => ({ id })) });
    if (path.endsWith("/messages")) {
      if (body?.status === "read") return json({ success: true });
      sent += 1;
      return json({ messages: [{ id: `wamid.OUT-${sent}.${run}` }] });
    }
    const mediaFile = media.get(path.slice(1));
    if (mediaFile)
      return json({
        url: `https://lookaside.test/${path.slice(1)}`,
        mime_type: mediaTypes.get(path.slice(1)) ?? "audio/ogg; codecs=opus",
        file_size: mediaFile.length,
      });
    if (/^\/\d+$/.test(path) && url.searchParams.get("fields")?.includes("platform_type"))
      return json({
        id: path.slice(1),
        platform_type: state.unregistered.has(path.slice(1)) ? "NOT_APPLICABLE" : "CLOUD_API",
        status: "CONNECTED",
        name_status: "APPROVED",
        messaging_limit_tier: "TIER_1K",
      });
    if (/^\/\d+$/.test(path))
      return json({
        id: path.slice(1),
        display_phone_number: "+974 4000 5555",
        verified_name: "Clinic",
        quality_rating: "GREEN",
      });
    return json({ error: { code: 100, message: `Unknown path ${path}` } }, 400);
  });
  return {
    calls,
    media,
    mediaTypes,
    state,
    uploads,
    /** Audio messages sent to customers: the uploaded media id */
    audios: () =>
      calls
        .filter((c) => c.path.endsWith("/messages") && c.body?.type === "audio")
        .map((c) => ({ to: String(c.body!.to), mediaId: String((c.body!.audio as { id: string }).id) })),
    /** Images, documents, videos sent to customers */
    files: () =>
      calls
        .filter(
          (c) =>
            c.path.endsWith("/messages") && ["image", "document", "video"].includes(String(c.body?.type)),
        )
        .map((c) => ({
          to: String(c.body!.to),
          type: String(c.body!.type),
          ...(c.body![String(c.body!.type)] as object),
        })),
    /** Templates sent to customers */
    templates: () =>
      calls
        .filter((c) => c.path.endsWith("/messages") && c.body?.type === "template")
        .map((c) => ({ to: String(c.body!.to), ...(c.body!.template as object) })),
    /** Blue ticks sent for customers' messages */
    reads: () =>
      calls
        .filter((c) => c.path.endsWith("/messages") && c.body?.status === "read")
        .map((c) => String(c.body!.message_id)),
    /** Text messages sent to customers, in order */
    texts: () =>
      calls
        .filter((c) => c.path.endsWith("/messages") && c.body?.type === "text")
        .map((c) => ({ to: String(c.body!.to), text: String((c.body!.text as { body: string }).body) })),
  };
}

/** Posts webhooks signed like Meta does */
export function webhookPoster(
  app: NestFastifyApplication,
  appSecret: string,
  phoneNumberId: string,
  wabaId = "WABA",
) {
  let seq = 0;
  const run = metaId();
  const postField = (field: string, value: Record<string, unknown>) => {
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: wabaId, changes: [{ field, value }] }],
    });
    return app.inject({
      method: "POST",
      url: "/api/v1/webhooks/whatsapp",
      payload: raw,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${createHmac("sha256", appSecret).update(raw).digest("hex")}`,
      },
    });
  };
  const post = (value: Record<string, unknown>) =>
    postField("messages", { metadata: { phone_number_id: phoneNumberId }, ...value });
  const message = (from: string, name: string, m: Record<string, unknown>) =>
    post({
      contacts: [{ wa_id: from, profile: { name } }],
      messages: [
        { from, id: `wamid.IN-${++seq}.${run}`, timestamp: String(Math.floor(Date.now() / 1000)), ...m },
      ],
    });
  return {
    post,
    postField,
    message,
    /** The owner wrote from the WhatsApp Business app (coexistence echo) */
    echo: (to: string, body: string) =>
      postField("smb_message_echoes", {
        metadata: { phone_number_id: phoneNumberId },
        message_echoes: [
          {
            from: "97440005555",
            to,
            id: `wamid.ECHO-${++seq}.${run}`,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: "text",
            text: { body },
          },
        ],
      }),
    text: (from: string, name: string, body: string) => message(from, name, { type: "text", text: { body } }),
    voice: (from: string, name: string, mediaId = metaId()) =>
      message(from, name, {
        type: "audio",
        audio: { id: mediaId, mime_type: "audio/ogg; codecs=opus", voice: true },
      }),
  };
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 40));
  }
}
