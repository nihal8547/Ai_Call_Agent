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
  /** Files customers "sent": media id → bytes */
  const media = new Map<string, Buffer>();
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
    calls.push({
      method,
      path,
      body,
      auth: String((init.headers as Record<string, string>)?.authorization ?? ""),
    });
    const waba = Object.keys(numbers).find((w) => path === `/${w}/phone_numbers`);
    if (waba) return json({ data: numbers[waba]!.map((id) => ({ id })) });
    if (path.endsWith("/messages")) {
      if (body?.status === "read") return json({ success: true });
      sent += 1;
      return json({ messages: [{ id: `wamid.OUT-${sent}.${run}` }] });
    }
    if (path.endsWith("/subscribed_apps") || path.endsWith("/register")) return json({ success: true });
    const mediaFile = media.get(path.slice(1));
    if (mediaFile)
      return json({
        url: `https://lookaside.test/${path.slice(1)}`,
        mime_type: "audio/ogg; codecs=opus",
        file_size: mediaFile.length,
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
    uploads,
    /** Audio messages sent to customers: the uploaded media id */
    audios: () =>
      calls
        .filter((c) => c.path.endsWith("/messages") && c.body?.type === "audio")
        .map((c) => ({ to: String(c.body!.to), mediaId: String((c.body!.audio as { id: string }).id) })),
    /** Text messages sent to customers, in order */
    texts: () =>
      calls
        .filter((c) => c.path.endsWith("/messages") && c.body?.type === "text")
        .map((c) => ({ to: String(c.body!.to), text: String((c.body!.text as { body: string }).body) })),
  };
}

/** Posts webhooks signed like Meta does */
export function webhookPoster(app: NestFastifyApplication, appSecret: string, phoneNumberId: string) {
  let seq = 0;
  const run = metaId();
  const post = (value: Record<string, unknown>) => {
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA",
          changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId }, ...value } }],
        },
      ],
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
  const message = (from: string, name: string, m: Record<string, unknown>) =>
    post({
      contacts: [{ wa_id: from, profile: { name } }],
      messages: [
        { from, id: `wamid.IN-${++seq}.${run}`, timestamp: String(Math.floor(Date.now() / 1000)), ...m },
      ],
    });
  return {
    post,
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
