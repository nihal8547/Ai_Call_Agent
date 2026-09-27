import { Inject, Injectable, Logger } from "@nestjs/common";
import { GeminiSpeech, SpeechError } from "@platform/ai";
import type { ConversationMessage, Prisma, WhatsAppNumber } from "@platform/db";
import { decodeVoiceNote, encodeVoiceNote, voiceNoteSeconds, wav } from "@platform/whatsapp";
import { API_ENV, type ApiEnv } from "../../config/env";
import { StorageService } from "../../infra/storage.service";
import { TenantDbService } from "../../infra/tenant-db.service";
import { MetricsService } from "../../observability/metrics.service";
import { UsageService } from "../usage/usage.service";
import { WhatsAppAccountsService } from "./whatsapp-accounts.service";

export const VOICE_MIME = "audio/ogg; codecs=opus";

/** Where a conversation's files live in object storage (private; served through the API) */
export const mediaKey = (tenantId: string, conversationId: string, messageId: string, ext: string) =>
  `tenants/${tenantId}/whatsapp/${conversationId}/${messageId}.${ext}`;

/** Spoken replies stay short: longer answers, links and lists are better read */
const MAX_SPOKEN_CHARS = 700;

/**
 * Voice notes: customers' are downloaded from Meta (their links expire within minutes), kept in
 * object storage and transcribed with Gemini; the agent's replies are spoken with Gemini and
 * encoded as Ogg/Opus voice notes.
 */
@Injectable()
export class WhatsAppMediaService {
  private readonly logger = new Logger(WhatsAppMediaService.name);
  readonly speech: GeminiSpeech | null;

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly tenantDb: TenantDbService,
    private readonly storage: StorageService,
    private readonly accounts: WhatsAppAccountsService,
    private readonly usage: UsageService,
    private readonly metrics: MetricsService,
  ) {
    this.speech = env.GEMINI_API_KEY
      ? new GeminiSpeech(env.GEMINI_API_KEY, {
          ...(env.GEMINI_TTS_MODEL ? { ttsModel: env.GEMINI_TTS_MODEL } : {}),
          baseUrl: env.GEMINI_API_BASE_URL,
          // Resolved per call, so tests can replace the global fetch
          fetch: (...args) => fetch(...args),
        })
      : null;
  }

  /**
   * Download, store and transcribe the voice notes among these messages (once each). Returns the
   * messages with their transcripts filled in.
   */
  async prepareVoiceNotes(
    tenantId: string,
    number: WhatsAppNumber,
    messages: ConversationMessage[],
    languageHint: string | undefined,
  ): Promise<ConversationMessage[]> {
    const todo = messages.filter(
      (m) => m.type === "AUDIO" && m.direction === "INBOUND" && m.mediaId && !m.mediaKey,
    );
    if (!todo.length) return messages;
    const token = (await this.accounts.credentials(tenantId, number).catch(() => null))?.accessToken;
    if (!token) return messages;
    const done = new Map<string, ConversationMessage>();
    for (const m of todo) {
      try {
        done.set(m.id, await this.prepare(tenantId, token, m, languageHint));
      } catch (err) {
        this.logger.warn(
          { tenantId, messageId: m.id, err: (err as Error).message },
          "voice note not processed",
        );
        this.metrics.whatsappVoice.inc({ step: "download", result: "failed" });
      }
    }
    return messages.map((m) => done.get(m.id) ?? m);
  }

  private async prepare(tenantId: string, token: string, m: ConversationMessage, languageHint?: string) {
    const graph = this.accounts.graph;
    const info = await graph.mediaInfo(token, m.mediaId!);
    const file = await graph.download(token, info.url, this.env.WHATSAPP_MEDIA_MAX_MB * 1024 * 1024);
    const key = mediaKey(tenantId, m.conversationId, m.id, "ogg");
    await this.storage.storage.put(key, file, info.mimeType);
    let seconds: number | null = null;
    try {
      seconds = Math.round(voiceNoteSeconds(file));
    } catch {
      seconds = null; // not Ogg/Opus (an audio file, not a voice note): Gemini may still read it
    }
    const data: Prisma.ConversationMessageUpdateInput = {
      mediaKey: key,
      mediaMime: info.mimeType.slice(0, 100),
      mediaBytes: file.length,
      mediaSeconds: seconds,
    };
    if (seconds !== null && seconds > this.env.WHATSAPP_VOICE_MAX_SECONDS) {
      data.meta = { ...(m.meta as object), voice: true, tooLong: true } as Prisma.InputJsonObject;
    } else if (this.speech) {
      const t = await this.transcribe(file, info.mimeType, languageHint);
      if (t) {
        data.transcript = t.text;
        data.transcriptLanguage = t.language;
        await this.tenantDb.tx(tenantId, (tx) =>
          this.usage.record(tx, tenantId, null, [
            { kind: "STT_SECONDS", quantity: seconds ?? 0, provider: "gemini", model: t.usage.model },
            {
              kind: "LLM_INPUT_TOKENS",
              quantity: t.usage.inputTokens,
              provider: "gemini",
              model: t.usage.model,
            },
            {
              kind: "LLM_OUTPUT_TOKENS",
              quantity: t.usage.outputTokens,
              provider: "gemini",
              model: t.usage.model,
            },
          ]),
        );
      }
    }
    this.metrics.whatsappVoice.inc({
      step: "transcribe",
      result: data.transcript !== undefined ? "ok" : "skipped",
    });
    return this.tenantDb.db(tenantId).conversationMessage.update({ where: { id: m.id }, data });
  }

  /** Voice notes go to Gemini as they are; if it refuses the format, as a 16 kHz WAV */
  private async transcribe(file: Buffer, mime: string, languageHint?: string) {
    const opts = { ...(languageHint ? { languageHint } : {}), timeoutMs: 30_000 };
    try {
      return await this.speech!.transcribe(file, mime.split(";")[0]!.trim(), opts);
    } catch (err) {
      if (!(err instanceof SpeechError) || err.kind !== "unsupported_audio") throw err;
      const { pcm } = decodeVoiceNote(file, 16_000);
      return this.speech!.transcribe(wav(pcm, 16_000), "audio/wav", opts);
    }
  }

  /** Is this reply suitable to speak? (short, no links) */
  canSpeak(text: string): boolean {
    return Boolean(this.speech) && text.length <= MAX_SPOKEN_CHARS && !/https?:\/\/|www\./i.test(text);
  }

  /**
   * The agent's reply as a voice note, stored for sending and for staff to play.
   * Returns null when speech fails (the reply is then sent as text).
   */
  async speak(
    tenantId: string,
    conversationId: string,
    messageId: string,
    text: string,
    voice: string,
  ): Promise<{ key: string; seconds: number; model: string } | null> {
    if (!this.speech) return null;
    try {
      const out = await this.speech.synthesize(text, { voice, timeoutMs: 25_000 });
      const rate = [8000, 12000, 16000, 24000, 48000].includes(out.sampleRate) ? out.sampleRate : 24_000;
      const { ogg, seconds } = encodeVoiceNote(out.pcm, rate as 24000);
      const key = mediaKey(tenantId, conversationId, messageId, "ogg");
      await this.storage.storage.put(key, ogg, VOICE_MIME);
      this.metrics.whatsappVoice.inc({ step: "speak", result: "ok" });
      return { key, seconds: Math.max(1, Math.round(seconds)), model: out.model };
    } catch (err) {
      this.logger.warn(
        { tenantId, conversationId, err: (err as Error).message },
        "voice reply failed; sending text",
      );
      this.metrics.whatsappVoice.inc({ step: "speak", result: "failed" });
      return null;
    }
  }

  /** Upload a stored voice note to Meta and send it */
  async sendVoice(token: string, phoneNumberId: string, to: string, key: string): Promise<{ wamid: string }> {
    const file = await this.storage.storage.get(key);
    const mediaId = await this.accounts.graph.uploadMedia(
      token,
      phoneNumberId,
      file,
      "audio/ogg",
      "reply.ogg",
    );
    return this.accounts.graph.sendAudio(token, phoneNumberId, to, mediaId);
  }
}
