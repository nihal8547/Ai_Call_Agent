import twilio from "twilio";
import { describe, expect, it } from "vitest";
import {
  parseRelayMessage,
  relayEnd,
  relayText,
  relayTranscriber,
  relayTts,
  renderConversationRelay,
} from "../src";

describe("ConversationRelay TwiML", () => {
  const opts = {
    url: "wss://api.example.com/telephony/twilio/relay",
    action: "https://api.example.com/telephony/twilio/relay-end",
    greeting: "Hello, you've reached Pearl Dental & Co. May I have your name?",
    language: "ar-QA",
    tts: { provider: "Amazon" as const, voice: "Hala-Neural" },
    transcriber: "Google" as const,
    hints: ["تنظيف", "زراعة"],
    parameters: { token: "abc<def>" },
  };

  it("matches what the official twilio library renders", () => {
    const r = new twilio.twiml.VoiceResponse();
    const relay = r.connect({ action: opts.action, method: "POST" }).conversationRelay({
      url: opts.url,
      welcomeGreeting: opts.greeting,
      welcomeGreetingInterruptible: "any",
      language: "ar-QA",
      ttsProvider: "Amazon",
      voice: "Hala-Neural",
      transcriptionProvider: "Google",
      interruptible: "any",
      dtmfDetection: true,
      hints: "تنظيف,زراعة",
    });
    relay.parameter({ name: "token", value: "abc<def>" });
    const ours = renderConversationRelay(opts);
    // Same document, whatever the attribute order and quoting
    const norm = (xml: string) =>
      xml
        .replace(/&gt;/g, ">")
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/<(\w+)((?: [\w]+="[^"]*")*)\s*(\/?)>/g, (_, tag: string, a: string, self: string) => {
          const sorted = (a.match(/ [\w]+="[^"]*"/g) ?? []).sort().join("");
          return `<${tag}${sorted}${self ? "/" : ""}>`;
        })
        .replace(/<(\w+)((?: [\w]+="[^"]*")*)><\/\1>/g, "<$1$2/>");
    expect(norm(ours)).toBe(norm(r.toString()));
  });

  it("maps the agent's Polly voice and picks a transcriber per language", () => {
    expect(relayTts("Polly.Kajal-Neural")).toEqual({ provider: "Amazon", voice: "Kajal-Neural" });
    expect(relayTranscriber("ar-QA", "auto")).toBe("Google");
    expect(relayTranscriber("en-IN", "auto")).toBe("Deepgram");
    expect(relayTranscriber("ar-QA", "deepgram")).toBe("Deepgram");
  });
});

describe("ConversationRelay messages", () => {
  it("parses what Twilio sends and ignores anything else", () => {
    expect(
      parseRelayMessage(
        JSON.stringify({
          type: "setup",
          sessionId: "VX1",
          callSid: "CA1234567890abcdef",
          from: "+97455123456",
          to: "+15550001111",
          customParameters: { token: "t1", evil: { nested: true } },
        }),
      ),
    ).toEqual({
      type: "setup",
      callSid: "CA1234567890abcdef",
      sessionId: "VX1",
      from: "+97455123456",
      to: "+15550001111",
      customParameters: { token: "t1" },
    });
    expect(
      parseRelayMessage('{"type":"prompt","voicePrompt":"Hi there","lang":"en-US","last":true}'),
    ).toEqual({ type: "prompt", text: "Hi there", lang: "en-US", last: true });
    expect(
      parseRelayMessage(
        '{"type":"interrupt","utteranceUntilInterrupt":"Hello, you","durationUntilInterruptMs":800}',
      ),
    ).toEqual({ type: "interrupt", heard: "Hello, you", spokenMs: 800 });
    expect(parseRelayMessage('{"type":"dtmf","digit":"5"}')).toEqual({ type: "dtmf", digit: "5" });
    expect(parseRelayMessage('{"type":"dtmf","digit":"55"}')).toBeNull();
    expect(parseRelayMessage('{"type":"setup","callSid":"not-a-call"}')).toBeNull();
    expect(parseRelayMessage("not json")).toBeNull();
    expect(parseRelayMessage("[1,2]")).toBeNull();
    expect(parseRelayMessage('{"type":"surprise"}')).toBeNull();
  });

  it("builds text and end messages", () => {
    expect(JSON.parse(relayText("Hello"))).toEqual({ type: "text", token: "Hello", last: true });
    expect(JSON.parse(relayEnd({ reason: "hangup" }))).toEqual({
      type: "end",
      handoffData: '{"reason":"hangup"}',
    });
  });
});
