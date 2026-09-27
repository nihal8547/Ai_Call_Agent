import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GraphClient,
  kindForGraphError,
  parseWebhook,
  verifyWebhookSignature,
  waIdToE164,
  WhatsAppError,
} from "../src";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const webhook = (value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA1",
      changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN1" }, ...value } }],
    },
  ],
});

describe("webhook signature", () => {
  const secret = "app-secret-123";
  const body = Buffer.from(JSON.stringify({ hello: "مرحبا" }));
  const sign = (b: Buffer) => `sha256=${createHmac("sha256", secret).update(b).digest("hex")}`;

  it("accepts Meta's signature over the raw bytes, nothing else", () => {
    expect(verifyWebhookSignature(body, sign(body), secret)).toBe(true);
    expect(verifyWebhookSignature(body, sign(Buffer.from("{}")), secret)).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(body.toString() + " "), sign(body), secret)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
    expect(verifyWebhookSignature(body, "sha1=abc", secret)).toBe(false);
    expect(verifyWebhookSignature(body, "sha256=zz", secret)).toBe(false);
  });
});

describe("parseWebhook", () => {
  it("reads every message type with the sender's name", () => {
    const events = parseWebhook(
      webhook({
        contacts: [{ wa_id: "97455123456", profile: { name: "Ahmed" } }],
        messages: [
          { from: "97455123456", id: "w1", timestamp: "1790000000", type: "text", text: { body: "مرحبا" } },
          {
            from: "97455123456",
            id: "w2",
            timestamp: "1790000001",
            type: "audio",
            audio: { id: "m1", mime_type: "audio/ogg; codecs=opus", voice: true },
          },
          {
            from: "97455123456",
            id: "w3",
            timestamp: "1790000002",
            type: "document",
            document: { id: "m2", mime_type: "application/pdf", filename: "id.pdf", caption: "My ID" },
            context: { id: "w0" },
          },
          {
            from: "97455123456",
            id: "w4",
            timestamp: "1790000003",
            type: "location",
            location: { latitude: 25.37, longitude: 51.54, name: "Lusail" },
          },
          {
            from: "97455123456",
            id: "w5",
            timestamp: "1790000004",
            type: "interactive",
            interactive: { type: "button_reply", button_reply: { id: "yes", title: "Yes, book it" } },
          },
          {
            from: "97455123456",
            id: "w6",
            timestamp: "1790000005",
            type: "reaction",
            reaction: { message_id: "w1", emoji: "👍" },
          },
          { from: "97455123456", id: "w7", timestamp: "1790000006", type: "order" },
          { nonsense: true },
        ],
      }),
    );
    expect(events).toHaveLength(7);
    expect(events[0]).toMatchObject({
      kind: "message",
      phoneNumberId: "PN1",
      from: "97455123456",
      profileName: "Ahmed",
      wamid: "w1",
      type: "TEXT",
      text: "مرحبا",
      timestamp: new Date(1790000000 * 1000),
    });
    expect(events[1]).toMatchObject({
      type: "AUDIO",
      media: { id: "m1", voice: true, mimeType: "audio/ogg; codecs=opus" },
    });
    expect(events[2]).toMatchObject({
      type: "DOCUMENT",
      text: "My ID",
      media: { filename: "id.pdf" },
      replyTo: "w0",
    });
    expect(events[3]).toMatchObject({ type: "LOCATION", text: "Lusail (25.37, 51.54)" });
    expect(events[4]).toMatchObject({ type: "INTERACTIVE", text: "Yes, book it" });
    expect(events[5]).toMatchObject({ type: "REACTION", text: "👍", replyTo: "w1" });
    expect(events[6]).toMatchObject({ type: "UNSUPPORTED", text: null });
  });

  it("reads delivery statuses with Meta's error", () => {
    const events = parseWebhook(
      webhook({
        statuses: [
          { id: "o1", status: "delivered", timestamp: "1790000010", recipient_id: "974551" },
          {
            id: "o2",
            status: "failed",
            timestamp: "1790000011",
            recipient_id: "974551",
            errors: [
              { code: 131047, title: "Re-engagement message", error_data: { details: "More than 24 hours" } },
            ],
          },
          { id: "o3", status: "deleted", timestamp: "1", recipient_id: "1" },
        ],
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({ kind: "status", wamid: "o1", status: "delivered", error: null }),
      expect.objectContaining({
        wamid: "o2",
        status: "failed",
        error: { code: 131047, title: "Re-engagement message", detail: "More than 24 hours" },
      }),
    ]);
  });

  it("ignores other objects, fields and garbage", () => {
    expect(parseWebhook({ object: "page", entry: [] })).toEqual([]);
    expect(parseWebhook(null)).toEqual([]);
    expect(
      parseWebhook({
        object: "whatsapp_business_account",
        entry: [{ changes: [{ field: "account_update", value: {} }] }],
      }),
    ).toEqual([]);
  });

  it("reads messages the business sent from the WhatsApp Business app (echoes)", () => {
    const events = parseWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA1",
          changes: [
            {
              field: "smb_message_echoes",
              value: {
                metadata: { phone_number_id: "PN1" },
                message_echoes: [
                  {
                    from: "97440005555",
                    to: "97455123456",
                    id: "wamid.E1",
                    timestamp: "1700000000",
                    type: "text",
                    text: { body: "On my way" },
                  },
                  {
                    from: "97440005555",
                    id: "wamid.E2",
                    timestamp: "1700000000",
                    type: "text",
                    text: { body: "no recipient" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(events).toEqual([
      expect.objectContaining({
        kind: "echo",
        phoneNumberId: "PN1",
        to: "97455123456",
        wamid: "wamid.E1",
        type: "TEXT",
        text: "On my way",
      }),
    ]);
  });

  it("reads account and quality news for the WhatsApp Business account", () => {
    const account = (field: string, value: Record<string, unknown>) =>
      parseWebhook({
        object: "whatsapp_business_account",
        entry: [{ id: "WABA1", changes: [{ field, value }] }],
      });
    expect(account("account_update", { event: "PARTNER_REMOVED" })).toEqual([
      { kind: "account", wabaId: "WABA1", number: null, event: "PARTNER_REMOVED", detail: null },
    ]);
    expect(
      account("account_update", {
        phone_number: "+974 4000 5555",
        event: "ACCOUNT_VIOLATION",
        violation_info: { violation_type: "SCAM" },
      }),
    ).toEqual([
      { kind: "account", wabaId: "WABA1", number: "97440005555", event: "ACCOUNT_VIOLATION", detail: "SCAM" },
    ]);
    expect(
      account("phone_number_quality_update", {
        display_phone_number: "97440005555",
        event: "DOWNGRADE",
        current_limit: "TIER_250",
      }),
    ).toEqual([
      {
        kind: "quality",
        wabaId: "WABA1",
        number: "97440005555",
        event: "DOWNGRADE",
        currentLimit: "TIER_250",
      },
    ]);
  });

  it("formats WhatsApp ids as E.164", () => {
    expect(waIdToE164("97455123456")).toBe("+97455123456");
  });
});

describe("GraphClient", () => {
  const client = (impl: (url: string, init: RequestInit) => Response | Promise<Response>) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return impl(String(url), init ?? {});
    });
    return {
      calls,
      graph: new GraphClient({
        fetch: fetchMock as unknown as typeof fetch,
        version: "v23.0",
        timeoutMs: 1000,
      }),
    };
  };

  it("sends a text reply quoting the customer's message", async () => {
    const { graph, calls } = client(() => json({ messages: [{ id: "wamid.OUT" }] }));
    await expect(graph.sendText("tok", "PN1", "97455123456", "Hello", { replyTo: "w1" })).resolves.toEqual({
      wamid: "wamid.OUT",
    });
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v23.0/PN1/messages");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "97455123456",
      type: "text",
      text: { body: "Hello", preview_url: false },
      context: { message_id: "w1" },
    });
  });

  it("exchanges the Embedded Signup code, subscribes and registers", async () => {
    const { graph, calls } = client((url) =>
      url.includes("oauth/access_token") ? json({ access_token: "biz-token" }) : json({ success: true }),
    );
    expect(await graph.exchangeCode("app", "secret", "the-code")).toBe("biz-token");
    await graph.subscribeApp("biz-token", "WABA1");
    await graph.register("biz-token", "PN1", "123456");
    expect(calls[0]!.url).toContain(
      "/v23.0/oauth/access_token?client_id=app&client_secret=secret&code=the-code",
    );
    expect(calls[1]!.url).toBe("https://graph.facebook.com/v23.0/WABA1/subscribed_apps");
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ messaging_product: "whatsapp", pin: "123456" });
  });

  it("checks a number's readiness and the account's webhook subscriptions", async () => {
    const { graph } = client((url) =>
      url.includes("subscribed_apps")
        ? json({ data: [{ whatsapp_business_api_data: { id: "APP1", name: "Platform" } }] })
        : url.includes("platform_type")
          ? json({
              platform_type: "CLOUD_API",
              status: "CONNECTED",
              name_status: "APPROVED",
              messaging_limit_tier: "TIER_1K",
            })
          : json({
              id: "PN1",
              display_phone_number: "+974 4000 5555",
              verified_name: "Clinic",
              quality_rating: "GREEN",
            }),
    );
    expect(await graph.subscribedApps("tok", "WABA1")).toEqual(["APP1"]);
    expect(await graph.phoneNumberHealth("tok", "PN1")).toMatchObject({
      displayPhoneNumber: "+974 4000 5555",
      platformType: "CLOUD_API",
      nameStatus: "APPROVED",
      messagingLimit: "TIER_1K",
    });
    // A field Meta no longer knows: the basic details still come back
    const old = client((url) =>
      url.includes("platform_type")
        ? json(
            {
              error: {
                code: 100,
                message: "(#100) Tried accessing nonexisting field (messaging_limit_tier)",
              },
            },
            400,
          )
        : json({ id: "PN1", display_phone_number: "+974 4000 5555" }),
    );
    expect(await old.graph.phoneNumberHealth("tok", "PN1")).toMatchObject({
      platformType: null,
      displayPhoneNumber: "+974 4000 5555",
    });
  });

  it("sends media, templates with values, and lists templates", async () => {
    const { graph, calls } = client((url) =>
      url.includes("message_templates")
        ? json({
            data: [
              {
                id: "T1",
                name: "appointment_reminder",
                language: "en",
                status: "APPROVED",
                category: "UTILITY",
                components: [
                  { type: "HEADER", format: "TEXT", text: "Hi {{1}}" },
                  { type: "BODY", text: "Your visit is on {{1}} at {{2}}." },
                  { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "OK" }] },
                ],
              },
            ],
          })
        : json({ messages: [{ id: "wamid.OUT" }] }),
    );
    await graph.sendMedia("tok", "PN1", "974551", "document", "M1", {
      caption: "Price list",
      filename: "prices.pdf",
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      type: "document",
      document: { id: "M1", caption: "Price list", filename: "prices.pdf" },
    });
    await graph.sendTemplate("tok", "PN1", "974551", "appointment_reminder", "en", {
      header: ["Aisha"],
      body: ["Sunday", "10 AM"],
    });
    expect(JSON.parse(String(calls[1]!.init.body)).template).toEqual({
      name: "appointment_reminder",
      language: { code: "en" },
      components: [
        { type: "header", parameters: [{ type: "text", text: "Aisha" }] },
        {
          type: "body",
          parameters: [
            { type: "text", text: "Sunday" },
            { type: "text", text: "10 AM" },
          ],
        },
      ],
    });
    expect(await graph.messageTemplates("tok", "WABA1")).toEqual([
      {
        id: "T1",
        name: "appointment_reminder",
        language: "en",
        status: "APPROVED",
        category: "UTILITY",
        headerFormat: "TEXT",
        headerText: "Hi {{1}}",
        body: "Your visit is on {{1}} at {{2}}.",
        footer: null,
        buttons: [{ type: "QUICK_REPLY", text: "OK", url: null }],
      },
    ]);
  });

  it("turns Meta errors into kinds the platform acts on", async () => {
    const { graph } = client(() =>
      json({ error: { message: "(#131047) Re-engagement message", code: 131047 } }, 400),
    );
    const err = await graph.sendText("tok", "PN1", "1", "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WhatsAppError);
    expect(err).toMatchObject({ kind: "window_closed", code: 131047, retryable: false });
    expect((err as Error).message).toBe("Re-engagement message");

    expect(kindForGraphError(401, 190)).toBe("auth");
    expect(kindForGraphError(400, 130429)).toBe("rate_limited");
    expect(kindForGraphError(503, undefined)).toBe("transient");
    expect(kindForGraphError(400, 100)).toBe("invalid");
    expect(kindForGraphError(403, 200)).toBe("permission");
  });

  it("reports network failures as retryable and refuses odd ids", async () => {
    const { graph } = client(() => {
      throw new TypeError("fetch failed");
    });
    await expect(graph.phoneNumber("tok", "PN1")).rejects.toMatchObject({
      kind: "transient",
      retryable: true,
    });
    await expect(graph.phoneNumber("tok", "../me")).rejects.toMatchObject({ kind: "invalid" });
  });

  it("downloads media within the size limit only", async () => {
    const { graph } = client((url) =>
      url.includes("/MEDIA1")
        ? json({ url: "https://lookaside.fbsbx.com/x", mime_type: "audio/ogg", file_size: 5 })
        : new Response(Buffer.from("hello"), { status: 200 }),
    );
    const info = await graph.mediaInfo("tok", "MEDIA1");
    expect(info).toEqual({ url: "https://lookaside.fbsbx.com/x", mimeType: "audio/ogg", fileSize: 5 });
    expect((await graph.download("tok", info.url, 10)).toString()).toBe("hello");
    await expect(graph.download("tok", info.url, 3)).rejects.toMatchObject({ kind: "invalid" });
  });
});
