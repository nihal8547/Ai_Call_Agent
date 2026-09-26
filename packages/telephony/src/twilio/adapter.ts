import type { InboundCall, TelephonyAdapter, VoiceReply } from "../types";
import { verifyTwilioSignature } from "./signature";
import { renderTwiml } from "./twiml";

export class TwilioAdapter implements TelephonyAdapter {
  readonly provider = "TWILIO" as const;

  constructor(private readonly authToken: string) {}

  verifySignature({
    url,
    params,
    signature,
  }: {
    url: string;
    params: Record<string, string>;
    signature: string | undefined;
  }): boolean {
    return verifyTwilioSignature(this.authToken, url, params, signature);
  }

  parse(p: Record<string, string>): InboundCall {
    const confidence = p.Confidence !== undefined ? Number(p.Confidence) : undefined;
    return {
      callSid: p.CallSid ?? "",
      from: p.From ?? "",
      to: p.To ?? "",
      status: p.CallStatus ?? "",
      ...(p.SpeechResult !== undefined
        ? { speech: { transcript: p.SpeechResult, ...(Number.isFinite(confidence) ? { confidence } : {}) } }
        : {}),
      ...(p.CallDuration !== undefined ? { durationSeconds: Number(p.CallDuration) } : {}),
      ...(p.DialCallStatus !== undefined ? { dialStatus: p.DialCallStatus } : {}),
    };
  }

  render(reply: VoiceReply): { contentType: string; body: string } {
    return { contentType: "text/xml", body: renderTwiml(reply) };
  }
}
