/** Provider-neutral description of what to do on the call next */
export type VoiceReply = {
  say: string;
  voice: string;
  language: string;
  /** Listen for the caller's answer and post it to `action` */
  listen?: { action: string; hints: string[]; timeoutSeconds?: number };
  /** `whisperUrl`: TwiML played to the person answering before they are connected (a call summary) */
  transfer?: { to: string; callerId?: string; statusCallback?: string; whisperUrl?: string };
  hangup?: boolean;
};

export type InboundCall = {
  callSid: string;
  from: string;
  to: string;
  status: string;
  /** Present on speech results */
  speech?: { transcript: string; confidence?: number };
  durationSeconds?: number;
  /** Outcome of a <Dial> transfer: completed, answered, busy, no-answer, failed, canceled */
  dialStatus?: string;
};

export interface TelephonyAdapter {
  readonly provider: "TWILIO" | "TELNYX" | "PLIVO" | "SIP";
  verifySignature(input: {
    url: string;
    params: Record<string, string>;
    signature: string | undefined;
  }): boolean;
  parse(params: Record<string, string>): InboundCall;
  render(reply: VoiceReply): { contentType: string; body: string };
}
