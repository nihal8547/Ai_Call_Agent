/** Provider-neutral description of what to do on the call next */
export type VoiceReply = {
  say: string;
  voice: string;
  language: string;
  /** Listen for the caller's answer and post it to `action` */
  listen?: { action: string; hints: string[]; timeoutSeconds?: number };
  transfer?: { to: string; callerId?: string; statusCallback?: string };
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
