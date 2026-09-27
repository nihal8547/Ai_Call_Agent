import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { parseRelayMessage, relayEnd, relayText, type RelayInbound } from "@platform/telephony";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { API_ENV, type ApiEnv } from "../../config/env";
import { MetricsService } from "../../observability/metrics.service";
import { RELAY_PATH, type RelayOutcome, TelephonyService } from "./telephony.service";

/** A session must say who it is this soon after connecting */
const SETUP_MS = 5000;
/** Keypad digits are one answer until # or a pause */
const DTMF_PAUSE_MS = 2500;

/**
 * The WebSocket end of streaming calls (Twilio ConversationRelay). Twilio connects when a call
 * is handed to the session; the handshake is signed by Twilio and the first message must carry
 * the call's one-time token. Each caller sentence runs through the same runtime as turn-by-turn
 * calls, and the reply goes back as text for Twilio to speak.
 */
@Injectable()
export class RelayGateway implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RelayGateway.name);
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private server: Server | null = null;

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly adapterHost: HttpAdapterHost,
    private readonly telephony: TelephonyService,
    private readonly metrics: MetricsService,
  ) {}

  onApplicationBootstrap(): void {
    this.server = (this.adapterHost.httpAdapter.getHttpServer() as Server | undefined) ?? null;
    this.server?.on("upgrade", this.onUpgrade);
  }

  onModuleDestroy(): void {
    this.server?.off("upgrade", this.onUpgrade);
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }

  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== RELAY_PATH) return refuse(socket, 404, "Not Found");
    const twilio = this.telephony.twilio;
    if (!twilio) return refuse(socket, 503, "Service Unavailable");
    // Twilio signs the handshake with the URL it was given (no body parameters)
    const signature = req.headers["x-twilio-signature"];
    const query = (req.url ?? "").slice(path.length);
    const url = `${this.telephony.relayUrl()}${query}`;
    if (
      !twilio.verifySignature({
        url,
        params: {},
        signature: typeof signature === "string" ? signature : undefined,
      })
    ) {
      this.logger.warn({ url }, "rejected streaming session with an invalid Twilio signature");
      this.metrics.relay.inc({ event: "refused" });
      return refuse(socket, 403, "Forbidden");
    }
    this.wss.handleUpgrade(req, socket, head, (ws) =>
      new RelaySession(ws, this.telephony, this.env, this.metrics, this.logger).start(),
    );
  };
}

function refuse(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** One call's streaming session */
class RelaySession {
  private callSid: string | null = null;
  private sessionId = "";
  private filler = "";
  /** Turns run one at a time, in order */
  private queue: Promise<void> = Promise.resolve();
  private silence: NodeJS.Timeout | null = null;
  private dtmfTimer: NodeJS.Timeout | null = null;
  private digits = "";
  private bargeIn = false;
  private ended = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly telephony: TelephonyService,
    private readonly env: ApiEnv,
    private readonly metrics: MetricsService,
    private readonly logger: Logger,
  ) {}

  start(): void {
    const setupTimer = setTimeout(() => {
      if (!this.callSid) this.close(1008, "setup expected");
    }, SETUP_MS);
    this.ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const m = parseRelayMessage(rawText(data));
      if (m) this.onMessage(m, setupTimer);
    });
    this.ws.on("close", () => this.stopTimers());
    this.ws.on("error", (err) => this.logger.warn({ err: err.message }, "streaming session socket error"));
  }

  private onMessage(m: RelayInbound, setupTimer: NodeJS.Timeout): void {
    if (!this.callSid) {
      if (m.type !== "setup") return this.close(1008, "setup expected");
      clearTimeout(setupTimer);
      this.callSid = m.callSid;
      this.sessionId = m.sessionId || m.callSid;
      this.enqueue(() => this.setup(m.customParameters.token));
      return;
    }
    switch (m.type) {
      case "prompt":
        this.clearSilence();
        if (!m.last || !m.text.trim()) return;
        this.enqueue(() => this.turn(m.text, false));
        return;
      case "interrupt":
        // The caller spoke over the agent: Twilio stopped the speech; their words come as a prompt
        this.clearSilence();
        this.bargeIn = true;
        this.metrics.relay.inc({ event: "interrupt" });
        return;
      case "dtmf":
        this.clearSilence();
        if (m.digit === "#") return this.flushDigits();
        this.digits = (this.digits + m.digit).slice(0, 30);
        if (this.dtmfTimer) clearTimeout(this.dtmfTimer);
        this.dtmfTimer = setTimeout(() => this.flushDigits(), DTMF_PAUSE_MS);
        return;
      case "error":
        this.metrics.relay.inc({ event: "error" });
        this.logger.warn(
          { callSid: this.callSid, error: m.description },
          "streaming session error from Twilio",
        );
        return;
      case "setup":
        return; // only the first one counts
    }
  }

  private async setup(token: string | undefined): Promise<void> {
    const ok = await this.telephony.relayConnect(this.callSid!, token, this.sessionId);
    if (!ok) {
      this.metrics.relay.inc({ event: "refused" });
      this.logger.warn({ callSid: this.callSid }, "streaming session refused: unknown call or wrong token");
      return this.close(1008, "unknown session");
    }
    this.filler = ok.filler;
    // Twilio is speaking the greeting now
    this.armSilence(ok.greeting);
  }

  private flushDigits(): void {
    if (this.dtmfTimer) clearTimeout(this.dtmfTimer);
    this.dtmfTimer = null;
    const digits = this.digits;
    this.digits = "";
    if (digits) this.enqueue(() => this.turn(digits, true));
  }

  private async turn(transcript: string, keypad: boolean): Promise<void> {
    if (this.ended) return;
    const started = Date.now();
    const bargeIn = this.bargeIn;
    this.bargeIn = false;
    // A slow reply (a booking, a long answer): let the caller know we're on it
    const filler =
      this.env.RELAY_FILLER_MS > 0 && transcript
        ? setTimeout(() => {
            this.metrics.relay.inc({ event: "filler" });
            this.send(relayText(this.filler));
          }, this.env.RELAY_FILLER_MS)
        : null;
    let outcome: RelayOutcome;
    try {
      outcome = await this.telephony.relayTurn(this.callSid!, this.sessionId, {
        transcript,
        ...(bargeIn ? { bargeIn } : {}),
        ...(keypad ? { keypad } : {}),
      });
    } catch (err) {
      this.logger.error({ err, callSid: this.callSid }, "streaming turn failed");
      outcome = { kind: "gone" };
    } finally {
      if (filler) clearTimeout(filler);
    }
    if (transcript) this.metrics.relayReply.observe((Date.now() - started) / 1000);
    if (outcome.kind === "say") {
      this.send(relayText(outcome.text));
      this.armSilence(outcome.text);
      return;
    }
    // The agent is done (goodbye or transfer), or the call is gone: Twilio asks relay-end what's next
    this.ended = true;
    this.stopTimers();
    this.send(relayEnd({ reason: outcome.kind === "end" ? outcome.reason : "gone" }));
  }

  /** If the caller says nothing after the agent's words, the agent re-prompts (and eventually ends) */
  private armSilence(text: string): void {
    this.clearSilence();
    if (this.ended) return;
    this.silence = setTimeout(
      () => {
        this.metrics.relay.inc({ event: "silence" });
        this.enqueue(() => this.turn("", false));
      },
      // Roughly when the agent's words end, plus the time a caller gets to answer
      Math.min(30_000, text.length * this.env.RELAY_SPEECH_CHAR_MS) + this.env.RELAY_SILENCE_MS,
    );
  }

  private clearSilence(): void {
    if (this.silence) clearTimeout(this.silence);
    this.silence = null;
  }

  private stopTimers(): void {
    this.clearSilence();
    if (this.dtmfTimer) clearTimeout(this.dtmfTimer);
    this.dtmfTimer = null;
  }

  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn).catch((err: unknown) => {
      this.logger.error({ err, callSid: this.callSid }, "streaming session step failed");
    });
  }

  private send(message: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(message);
  }

  private close(code: number, reason: string): void {
    this.ended = true;
    this.stopTimers();
    this.ws.close(code, reason);
  }
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data).toString("utf8");
}
