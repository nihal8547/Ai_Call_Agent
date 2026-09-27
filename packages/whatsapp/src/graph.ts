import { kindForGraphError, WhatsAppError } from "./errors";

export type GraphDeps = {
  fetch: typeof fetch;
  /** Graph API version, e.g. "v23.0" */
  version: string;
  timeoutMs: number;
  /** Tests point this at a fake; production uses Meta's */
  baseUrl?: string;
};

export type PhoneNumberInfo = {
  id: string;
  displayPhoneNumber: string;
  verifiedName: string | null;
  qualityRating: string | null;
  codeVerificationStatus: string | null;
};

export type MediaInfo = { url: string; mimeType: string; fileSize: number | null };

type GraphErrorBody = {
  error?: { message?: string; code?: number; error_user_msg?: string; error_data?: { details?: string } };
};

/**
 * WhatsApp Business Cloud API (Graph API) calls the platform needs. The access token is passed per
 * call: each business connects its own number, so each has its own token.
 */
export class GraphClient {
  private readonly base: string;

  constructor(private readonly deps: GraphDeps) {
    this.base = `${(deps.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, "")}/${deps.version}`;
  }

  // ── Connecting ────────────────────────────────────────────────────────────

  /** Embedded Signup: the code from Meta's popup → a business integration token */
  async exchangeCode(appId: string, appSecret: string, code: string): Promise<string> {
    const q = new URLSearchParams({ client_id: appId, client_secret: appSecret, code });
    const r = await this.call<{ access_token?: string }>("GET", `/oauth/access_token?${q}`, null);
    if (!r.access_token) throw new WhatsAppError("auth", "Meta did not return an access token");
    return r.access_token;
  }

  async phoneNumber(token: string, phoneNumberId: string): Promise<PhoneNumberInfo> {
    const fields = "display_phone_number,verified_name,quality_rating,code_verification_status";
    const r = await this.call<{
      id: string;
      display_phone_number?: string;
      verified_name?: string;
      quality_rating?: string;
      code_verification_status?: string;
    }>("GET", `/${enc(phoneNumberId)}?fields=${fields}`, token);
    return {
      id: r.id,
      displayPhoneNumber: r.display_phone_number ?? "",
      verifiedName: r.verified_name ?? null,
      qualityRating: r.quality_rating ?? null,
      codeVerificationStatus: r.code_verification_status ?? null,
    };
  }

  /** The phone number ids in a WhatsApp Business account (proves the token can use them) */
  async wabaPhoneNumberIds(token: string, wabaId: string): Promise<string[]> {
    const r = await this.call<{ data?: { id: string }[] }>(
      "GET",
      `/${enc(wabaId)}/phone_numbers?fields=id&limit=100`,
      token,
    );
    return (r.data ?? []).map((p) => p.id);
  }

  /** Send this account's webhooks to the platform's app */
  async subscribeApp(token: string, wabaId: string): Promise<void> {
    await this.call("POST", `/${enc(wabaId)}/subscribed_apps`, token, {});
  }

  async unsubscribeApp(token: string, wabaId: string): Promise<void> {
    await this.call("DELETE", `/${enc(wabaId)}/subscribed_apps`, token);
  }

  /** Register the number for the Cloud API, setting its two-step verification PIN */
  async register(token: string, phoneNumberId: string, pin: string): Promise<void> {
    await this.call("POST", `/${enc(phoneNumberId)}/register`, token, {
      messaging_product: "whatsapp",
      pin,
    });
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  async sendText(
    token: string,
    phoneNumberId: string,
    to: string,
    body: string,
    opts: { replyTo?: string | null; previewUrl?: boolean } = {},
  ): Promise<{ wamid: string }> {
    return this.send(token, phoneNumberId, {
      to,
      type: "text",
      text: { body, preview_url: opts.previewUrl ?? false },
      ...(opts.replyTo ? { context: { message_id: opts.replyTo } } : {}),
    });
  }

  /** An approved template (the only kind allowed outside the 24-hour window) */
  async sendTemplate(
    token: string,
    phoneNumberId: string,
    to: string,
    name: string,
    languageCode: string,
  ): Promise<{ wamid: string }> {
    return this.send(token, phoneNumberId, {
      to,
      type: "template",
      template: { name, language: { code: languageCode } },
    });
  }

  /** An uploaded file (voice note, document) sent to the customer */
  async sendAudio(
    token: string,
    phoneNumberId: string,
    to: string,
    mediaId: string,
  ): Promise<{ wamid: string }> {
    return this.send(token, phoneNumberId, { to, type: "audio", audio: { id: mediaId } });
  }

  /** Upload a file to send (valid for 30 days); returns Meta's media id */
  async uploadMedia(
    token: string,
    phoneNumberId: string,
    file: Buffer,
    mimeType: string,
    filename: string,
  ): Promise<string> {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append("file", new Blob([new Uint8Array(file)], { type: mimeType }), filename);
    const res = await this.fetchWithTimeout(`${this.base}/${enc(phoneNumberId)}/media`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string } & GraphErrorBody;
    if (!res.ok || !json.id) {
      const e = json.error;
      throw new WhatsAppError(
        kindForGraphError(res.status, e?.code),
        e?.message?.replace(/^\(#\d+\)\s*/, "") ?? `Upload failed (${res.status})`,
        e?.code ?? null,
        res.status,
      );
    }
    return json.id;
  }

  /** Blue ticks for the customer, optionally with "typing…" until the reply is sent */
  async markRead(token: string, phoneNumberId: string, wamid: string, typing = false): Promise<void> {
    await this.call("POST", `/${enc(phoneNumberId)}/messages`, token, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: wamid,
      ...(typing ? { typing_indicator: { type: "text" } } : {}),
    });
  }

  // ── Media ─────────────────────────────────────────────────────────────────

  /** A received file's short-lived download URL (valid for a few minutes) */
  async mediaInfo(token: string, mediaId: string): Promise<MediaInfo> {
    const r = await this.call<{ url?: string; mime_type?: string; file_size?: number }>(
      "GET",
      `/${enc(mediaId)}`,
      token,
    );
    if (!r.url) throw new WhatsAppError("invalid", "Meta returned no download URL for this file");
    return { url: r.url, mimeType: r.mime_type ?? "application/octet-stream", fileSize: r.file_size ?? null };
  }

  /** Download a received file, refusing anything larger than `maxBytes` */
  async download(token: string, url: string, maxBytes: number): Promise<Buffer> {
    const res = await this.fetchWithTimeout(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok)
      throw new WhatsAppError(
        kindForGraphError(res.status, undefined),
        `Download failed (${res.status})`,
        null,
        res.status,
      );
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) throw new WhatsAppError("invalid", "The file is too large");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new WhatsAppError("invalid", "The file is too large");
    return buf;
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────

  private async send(token: string, phoneNumberId: string, message: Record<string, unknown>) {
    const r = await this.call<{ messages?: { id: string }[] }>(
      "POST",
      `/${enc(phoneNumberId)}/messages`,
      token,
      { messaging_product: "whatsapp", recipient_type: "individual", ...message },
    );
    const wamid = r.messages?.[0]?.id;
    if (!wamid) throw new WhatsAppError("transient", "Meta accepted the message without an id");
    return { wamid };
  }

  private async call<T = unknown>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    token: string | null,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.fetchWithTimeout(`${this.base}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    if (!res.ok) {
      const e = (json as GraphErrorBody).error;
      const title = e?.message?.replace(/^\(#\d+\)\s*/, "");
      const message =
        e?.error_user_msg ||
        [title, e?.error_data?.details].filter(Boolean).join(": ") ||
        `Meta returned ${res.status}`;
      throw new WhatsAppError(kindForGraphError(res.status, e?.code), message, e?.code ?? null, res.status);
    }
    return json as T;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.deps.fetch(url, { ...init, signal: AbortSignal.timeout(this.deps.timeoutMs) });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new WhatsAppError("transient", timedOut ? "Meta did not answer in time" : "Could not reach Meta");
    }
  }
}

const enc = (id: string) => {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) throw new WhatsAppError("invalid", "Invalid WhatsApp id");
  return id;
};
