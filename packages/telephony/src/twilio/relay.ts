/**
 * Twilio ConversationRelay: streaming voice. Twilio recognises the caller's speech as it is spoken
 * and streams the agent's text as speech; the platform exchanges text with it over a WebSocket.
 * The caller can interrupt the agent (barge-in), and turn detection is Twilio's, not <Gather>'s.
 */

const escapeXml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const attrs = (a: Record<string, string | number | boolean | undefined>) =>
  Object.entries(a)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
    .join("");

export type RelayTts = { provider: "Amazon" | "Google" | "ElevenLabs"; voice: string };
export type RelayTranscriber = "Deepgram" | "Google";

export type RelaySessionOptions = {
  /** wss:// address of our relay endpoint */
  url: string;
  /** Requested when the session ends (the agent ended it, or it broke): returns the next TwiML */
  action: string;
  /** Spoken as soon as the session connects: the agent's greeting and first question */
  greeting: string;
  language: string;
  tts: RelayTts;
  transcriber: RelayTranscriber;
  hints?: string[];
  /** Arrive in the session's "setup" message (we pass a one-time token) */
  parameters?: Record<string, string>;
};

/** <Connect><ConversationRelay>: hands the call to the streaming session */
export function renderConversationRelay(o: RelaySessionOptions): string {
  const hints = (o.hints ?? []).slice(0, 100).join(",").slice(0, 1000);
  const params = Object.entries(o.parameters ?? {})
    .map(([name, value]) => `<Parameter${attrs({ name, value })}/>`)
    .join("");
  const relay = `<ConversationRelay${attrs({
    url: o.url,
    welcomeGreeting: o.greeting,
    welcomeGreetingInterruptible: "any",
    language: o.language,
    ttsProvider: o.tts.provider,
    voice: o.tts.voice,
    transcriptionProvider: o.transcriber,
    interruptible: "any",
    dtmfDetection: true,
    hints: hints || undefined,
  })}>${params}</ConversationRelay>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect${attrs({ action: o.action, method: "POST" })}>${relay}</Connect></Response>`;
}

/**
 * The agent's Polly voice for streaming. Amazon Polly neural voices are offered by ConversationRelay
 * too, so the caller hears the same voice in both modes and in the final words (spoken by <Say>).
 * "Polly.Hala-Neural" → Amazon "Hala-Neural".
 */
export function relayTts(voice: string): RelayTts {
  const polly = /^Polly\.(.+)$/.exec(voice);
  return polly ? { provider: "Amazon", voice: polly[1]! } : { provider: "Amazon", voice };
}

/** Deepgram for English and Hindi (fast endpointing); Google for Arabic (Gulf locales) */
export function relayTranscriber(language: string, choice: "auto" | "deepgram" | "google"): RelayTranscriber {
  if (choice === "deepgram") return "Deepgram";
  if (choice === "google") return "Google";
  return /^ar(?:-|$)/i.test(language) ? "Google" : "Deepgram";
}

// ── Messages ────────────────────────────────────────────────────────────────

export type RelayInbound =
  | {
      type: "setup";
      callSid: string;
      sessionId: string;
      from: string;
      to: string;
      customParameters: Record<string, string>;
    }
  | { type: "prompt"; text: string; lang: string | null; last: boolean }
  | { type: "interrupt"; heard: string; spokenMs: number | null }
  | { type: "dtmf"; digit: string }
  | { type: "error"; description: string };

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** A message from Twilio; null for anything malformed or unknown (ignored, never trusted) */
export function parseRelayMessage(raw: string): RelayInbound | null {
  let m: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    m = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (m.type) {
    case "setup": {
      const params = m.customParameters;
      const customParameters: Record<string, string> = {};
      if (params && typeof params === "object")
        for (const [k, v] of Object.entries(params)) if (typeof v === "string") customParameters[k] = v;
      const callSid = str(m.callSid);
      if (!/^CA[\w]{8,64}$/.test(callSid)) return null;
      return {
        type: "setup",
        callSid,
        sessionId: str(m.sessionId),
        from: str(m.from),
        to: str(m.to),
        customParameters,
      };
    }
    case "prompt":
      return {
        type: "prompt",
        text: str(m.voicePrompt).slice(0, 2000),
        lang: typeof m.lang === "string" ? m.lang : null,
        last: m.last !== false,
      };
    case "interrupt":
      return {
        type: "interrupt",
        heard: str(m.utteranceUntilInterrupt).slice(0, 2000),
        spokenMs: typeof m.durationUntilInterruptMs === "number" ? m.durationUntilInterruptMs : null,
      };
    case "dtmf":
      return /^[0-9*#A-D]$/.test(str(m.digit)) ? { type: "dtmf", digit: str(m.digit) } : null;
    case "error":
      return { type: "error", description: str(m.description).slice(0, 500) };
    default:
      return null;
  }
}

/** Speak this text (the whole reply, as one token) */
export const relayText = (text: string) => JSON.stringify({ type: "text", token: text, last: true });

/** End the session: Twilio then requests the <Connect action> URL for the next TwiML */
export const relayEnd = (handoffData: Record<string, unknown>) =>
  JSON.stringify({ type: "end", handoffData: JSON.stringify(handoffData) });
