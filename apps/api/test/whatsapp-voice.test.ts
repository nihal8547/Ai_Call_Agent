import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { decodeVoiceNote, encodeVoiceNote } from "@platform/whatsapp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TenantDbService } from "../src/infra/tenant-db.service";
import { createTestApp, hasTestDb, registerOwner } from "./support/app";
import { provisionAgent } from "./support/telephony";
import { fakeGraph, metaId, waitFor, webhookPoster } from "./support/whatsapp";

const APP_SECRET = "meta-app-secret-voice-0123456789";

/** Seconds of a speech-like tone, as mono 16-bit PCM */
function tone(rate: number, seconds: number): Buffer {
  const pcm = Buffer.alloc(Math.round(rate * seconds) * 2);
  for (let i = 0; i < pcm.length / 2; i++)
    pcm.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 220 * i) / rate)), i * 2);
  return pcm;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe.skipIf(!hasTestDb)("WhatsApp voice notes", () => {
  let app: NestFastifyApplication;
  let owner: Awaited<ReturnType<typeof registerOwner>>;
  let graph: ReturnType<typeof fakeGraph>;
  let hook: ReturnType<typeof webhookPoster>;
  const WABA = metaId();
  const PNID = metaId();
  const db = () => app.get(TenantDbService).db(owner.me.tenant.id);

  // What fake Gemini does next
  const gemini = { transcript: "", ttsFails: false, transcribed: 0, spoken: [] as string[] };

  /** The customer sends a voice note saying `said` (the fake Gemini hears exactly that) */
  async function voiceNote(from: string, said: string, seconds = 2) {
    gemini.transcript = said;
    const mediaId = metaId();
    graph.media.set(mediaId, encodeVoiceNote(tone(24_000, seconds), 24_000).ogg);
    expect((await hook.voice(from, "Aisha", mediaId)).statusCode).toBe(200);
    return mediaId;
  }
  const replies = (from: string) =>
    db().conversationMessage.findMany({
      where: { conversation: { contactWaId: from }, sender: "AI", status: "SENT" },
      orderBy: { createdAt: "asc" },
    });
  const number = () => db().whatsAppNumber.findFirstOrThrow({ where: { phoneNumberId: PNID } });

  beforeAll(async () => {
    app = await createTestApp({
      META_APP_SECRET: APP_SECRET,
      WHATSAPP_REPLY_DELAY_MS: "100",
      WHATSAPP_VOICE_MAX_SECONDS: "10",
      GEMINI_API_KEY: "test-gemini-key-0123456789",
    });
    owner = await registerOwner(app, "wa-voice");
    graph = fakeGraph({ [WABA]: [PNID] }, (body) => {
      const cfg = body.generationConfig as { responseModalities?: string[] };
      if (cfg?.responseModalities?.includes("AUDIO")) {
        const text = String((body.contents as { parts: { text: string }[] }[])[0]!.parts[0]!.text);
        gemini.spoken.push(text);
        if (gemini.ttsFails) return json({ error: { message: "overloaded" } }, 503);
        return json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: "audio/L16;codec=pcm;rate=24000",
                      data: tone(24_000, 1.5).toString("base64"),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      const parts = (body.contents as { parts: Record<string, unknown>[] }[])[0]!.parts;
      if (parts.some((p) => "inline_data" in p)) {
        gemini.transcribed += 1;
        return json({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify({ transcript: gemini.transcript, language: "en" }) }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 20 },
        });
      }
      // Understanding / phrasing: unavailable, so the agent uses its deterministic wording
      return json({ error: { message: "unavailable" } }, 500);
    });
    const agent = await provisionAgent(app, owner.me.tenant.id, "clinic-reception", {
      workingHours: undefined,
    } as never);
    expect(
      (
        await owner.client.post("/api/v1/whatsapp/connect/manual", {
          accessToken: "biz-token-voice-0123456789",
          wabaId: WABA,
          phoneNumberId: PNID,
          agentId: agent.agentId,
        })
      ).statusCode,
    ).toBe(201);
    hook = webhookPoster(app, APP_SECRET, PNID);
  });
  beforeEach(() => {
    gemini.ttsFails = false;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
  });

  it("transcribes a voice note and answers with a voice note", async () => {
    const from = "97455200001";
    await voiceNote(from, "Hi, I'd like to book a dental cleaning");
    const [reply] = await waitFor(async () => {
      const r = await replies(from);
      return r.length ? r : null;
    });
    // The customer's note: stored, measured and transcribed
    const note = await db().conversationMessage.findFirstOrThrow({
      where: { conversation: { contactWaId: from }, type: "AUDIO", direction: "INBOUND" },
    });
    expect(note).toMatchObject({
      transcript: "Hi, I'd like to book a dental cleaning",
      transcriptLanguage: "en",
      mediaSeconds: 2,
    });
    expect(note.mediaKey).toContain(`tenants/${owner.me.tenant.id}/whatsapp/`);

    // The reply: spoken, uploaded to Meta as Ogg/Opus and sent as audio; the words kept for staff
    expect(reply).toMatchObject({ type: "AUDIO", mediaMime: "audio/ogg; codecs=opus" });
    expect(reply!.text).toMatch(/May I have the patient's name\?/);
    expect(gemini.spoken.at(-1)).toBe(reply!.text);
    const sent = graph.audios().filter((a) => a.to === from);
    expect(sent).toHaveLength(1);
    const upload = graph.uploads.find((u) => u.id === sent[0]!.mediaId)!;
    expect(upload.type).toBe("audio/ogg");
    expect(decodeVoiceNote(upload.bytes).seconds).toBeCloseTo(1.5, 1);
    expect(graph.texts().filter((t) => t.to === from)).toHaveLength(0);

    // Staff play both notes from the Inbox; another business can't
    const conv = await db().conversation.findFirstOrThrow({ where: { contactWaId: from } });
    const played = await owner.client.get(`/api/v1/chats/${conv.id}/messages/${note.id}/media`);
    expect(played.statusCode).toBe(200);
    expect(played.headers["content-type"]).toBe("audio/ogg");
    expect(played.rawPayload.subarray(0, 4).toString()).toBe("OggS");
    expect(played.headers["accept-ranges"]).toBe("bytes");
    // The player seeks to the end for the length
    const tail = await owner.client.get(`/api/v1/chats/${conv.id}/messages/${note.id}/media`, {
      headers: { range: "bytes=-100" },
    });
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload.length).toBe(100);
    expect(tail.headers["content-range"]).toBe(
      `bytes ${played.rawPayload.length - 100}-${played.rawPayload.length - 1}/${played.rawPayload.length}`,
    );
    const other = await registerOwner(app, "wa-voice-peek");
    expect((await other.client.get(`/api/v1/chats/${conv.id}/messages/${note.id}/media`)).statusCode).toBe(
      404,
    );
    const listed = (await owner.client.get(`/api/v1/chats/${conv.id}/messages`)).json().items;
    expect(listed.find((m: { id: string }) => m.id === note.id)).toMatchObject({
      hasMedia: true,
      transcript: note.transcript,
    });
    expect(listed.some((m: Record<string, unknown>) => "mediaKey" in m)).toBe(false);

    // Metered: listening seconds and spoken characters
    const kinds = await db().usageRecord.findMany({
      where: { kind: { in: ["STT_SECONDS", "TTS_CHARACTERS"] }, createdAt: { gte: conv.createdAt } },
    });
    expect(kinds.map((k) => k.kind).sort()).toEqual(["STT_SECONDS", "TTS_CHARACTERS"]);
  });

  it("follows the number's setting: text only, or voice and text", async () => {
    const n = await number();
    const patch = (voiceReplies: string) =>
      owner.client.patch(`/api/v1/whatsapp/numbers/${n.id}`, { settings: { voiceReplies } });
    expect((await patch("text")).json().settings).toEqual({ voiceReplies: "text", voice: "Kore" });
    const a = "97455200002";
    await voiceNote(a, "Hello there");
    const [r] = await waitFor(async () => {
      const x = await replies(a);
      return x.length ? x : null;
    });
    expect(r!.type).toBe("TEXT");

    expect((await patch("both")).statusCode).toBe(200);
    const b = "97455200003";
    await voiceNote(b, "Hello there");
    const both = await waitFor(async () => {
      const x = await replies(b);
      return x.length === 2 ? x : null;
    });
    expect(both.map((m) => m.type).sort()).toEqual(["AUDIO", "TEXT"]);
    await patch("voice");
  });

  it("falls back to text when speech fails, and answers typed messages in writing", async () => {
    gemini.ttsFails = true;
    const from = "97455200004";
    await voiceNote(from, "Hi");
    const [r] = await waitFor(async () => {
      const x = await replies(from);
      return x.length ? x : null;
    });
    expect(r).toMatchObject({ type: "TEXT" });
    expect(r!.meta).toMatchObject({ voiceFallback: "text_only" });

    gemini.ttsFails = false;
    const typed = "97455200005";
    await hook.text(typed, "Omar", "Hello");
    const [t] = await waitFor(async () => {
      const x = await replies(typed);
      return x.length ? x : null;
    });
    expect(t!.type).toBe("TEXT");
  });

  it("asks for a shorter note when it's too long, and to type when nothing could be heard", async () => {
    const before = gemini.transcribed;
    const long = "97455200006";
    await voiceNote(long, "unused", 12);
    const [r1] = await waitFor(async () => {
      const x = await replies(long);
      return x.length ? x : null;
    });
    expect(r1!.text).toBe(
      "That voice message is a bit long for me. Could you send a shorter one or type it?",
    );
    expect(gemini.transcribed).toBe(before); // not sent to Gemini

    const silent = "97455200007";
    await voiceNote(silent, "");
    const [r2] = await waitFor(async () => {
      const x = await replies(silent);
      return x.length ? x : null;
    });
    expect(r2!.text).toBe("Sorry, I couldn't listen to that voice message. Could you type your message?");
  });

  it("transcribes for staff even while they handle the chat (no automatic reply)", async () => {
    const from = "97455200008";
    await hook.text(from, "Khalid", "Hi");
    await waitFor(async () => (await replies(from)).length > 0);
    const conv = await db().conversation.findFirstOrThrow({ where: { contactWaId: from } });
    await owner.client.post(`/api/v1/chats/${conv.id}/mode`, { mode: "HUMAN" });
    await voiceNote(from, "Can someone call me back?");
    const note = await waitFor(() =>
      db().conversationMessage.findFirst({
        where: { conversationId: conv.id, type: "AUDIO", transcript: { not: null } },
      }),
    );
    expect(note.transcript).toBe("Can someone call me back?");
    await new Promise((r) => setTimeout(r, 400));
    expect(await replies(from)).toHaveLength(1);
  });
});
