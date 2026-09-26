import type { VoiceReply } from "../types";

const escapeXml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const attrs = (a: Record<string, string | number | undefined>) =>
  Object.entries(a)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
    .join("");

/**
 * TwiML for one agent turn.
 * - listen: <Say> inside <Gather input="speech"> so the caller can interrupt (barge-in);
 *   actionOnEmptyResult makes silence post back too, so the agent can re-prompt.
 * - transfer: <Say> then <Dial>.
 * - hangup: <Say> then <Hangup/>.
 * - hangup: false (without listen/transfer): <Say> only; the call carries on.
 */
export function renderTwiml(reply: VoiceReply): string {
  const say = reply.say.trim()
    ? `<Say${attrs({ voice: reply.voice, language: reply.language })}>${escapeXml(reply.say)}</Say>`
    : "";
  let body: string;
  if (reply.transfer) {
    body = `${say}<Dial${attrs({ callerId: reply.transfer.callerId, timeout: 20, action: reply.transfer.statusCallback, method: "POST" })}><Number${attrs({ url: reply.transfer.whisperUrl, method: reply.transfer.whisperUrl ? "POST" : undefined })}>${escapeXml(reply.transfer.to)}</Number></Dial>`;
  } else if (reply.listen && !reply.hangup) {
    const hints = reply.listen.hints.slice(0, 100).join(",").slice(0, 1000);
    body = `<Gather${attrs({
      input: "speech",
      action: reply.listen.action,
      method: "POST",
      language: reply.language,
      speechTimeout: "auto",
      timeout: reply.listen.timeoutSeconds ?? 6,
      hints: hints || undefined,
      actionOnEmptyResult: "true",
    })}>${say}</Gather>`;
  } else if (reply.hangup === false) {
    // Say only, then let the call continue (e.g. a whisper before a transfer connects)
    body = say;
  } else {
    body = `${say}<Hangup/>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}
