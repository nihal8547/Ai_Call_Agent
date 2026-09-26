import twilio from "twilio";
import { describe, expect, it } from "vitest";
import { renderTwiml, TwilioAdapter, twilioSignature, verifyTwilioSignature } from "../src";

describe("Twilio signatures", () => {
  const token = "12345";
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = {
    CallSid: "CA1234567890ABCDE",
    Caller: "+12349013030",
    Digits: "1234",
    From: "+12349013030",
    To: "+18005551212",
  };

  it("match the official twilio library", () => {
    const sig = twilioSignature(token, url, params);
    expect(twilio.validateRequest(token, sig, url, params)).toBe(true);
    for (let i = 0; i < 20; i++) {
      const p = {
        CallSid: `CA${i}`,
        SpeechResult: `hello ${i} & <b>`,
        Confidence: String(i / 20),
        From: "+911234567890",
      };
      expect(
        twilio.validateRequest(
          "tok-" + i,
          twilioSignature("tok-" + i, `https://api.example.com/t?seq=${i}`, p),
          `https://api.example.com/t?seq=${i}`,
          p,
        ),
      ).toBe(true);
    }
  });

  it("reject tampering, wrong token, wrong url and missing signatures", () => {
    const sig = twilioSignature(token, url, params);
    expect(verifyTwilioSignature(token, url, params, sig)).toBe(true);
    expect(verifyTwilioSignature(token, url, { ...params, To: "+10000000000" }, sig)).toBe(false);
    expect(verifyTwilioSignature("other", url, params, sig)).toBe(false);
    expect(verifyTwilioSignature(token, url + "&x=1", params, sig)).toBe(false);
    expect(verifyTwilioSignature(token, url, params, undefined)).toBe(false);
    expect(verifyTwilioSignature("", url, params, sig)).toBe(false);
  });
});

describe("TwiML", () => {
  const base = { say: "Hello <there> & welcome", voice: "Polly.Kajal-Neural", language: "en-IN" };

  it("listens with barge-in, hints and empty-result callbacks, escaping text", () => {
    const xml = renderTwiml({
      ...base,
      listen: { action: "https://api.example.com/turn?seq=1&x=2", hints: ["Baner", "Wakad"] },
    });
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="speech" action="https://api.example.com/turn?seq=1&amp;x=2" method="POST" language="en-IN" speechTimeout="auto" timeout="6" hints="Baner,Wakad" actionOnEmptyResult="true"><Say voice="Polly.Kajal-Neural" language="en-IN">Hello &lt;there&gt; &amp; welcome</Say></Gather></Response>',
    );
  });

  it("transfers and hangs up", () => {
    expect(
      renderTwiml({
        ...base,
        transfer: { to: "+911140000099", statusCallback: "https://api.example.com/dial" },
      }),
    ).toContain(
      '<Dial timeout="20" action="https://api.example.com/dial" method="POST"><Number>+911140000099</Number></Dial>',
    );
    expect(renderTwiml({ ...base, hangup: true })).toMatch(/<\/Say><Hangup\/><\/Response>$/);
  });

  it("the adapter parses speech results and durations", () => {
    const a = new TwilioAdapter("t");
    expect(
      a.parse({
        CallSid: "CA1",
        From: "+91",
        To: "+92",
        CallStatus: "in-progress",
        SpeechResult: "hi",
        Confidence: "0.91",
      }),
    ).toEqual({
      callSid: "CA1",
      from: "+91",
      to: "+92",
      status: "in-progress",
      speech: { transcript: "hi", confidence: 0.91 },
    });
    expect(a.parse({ CallSid: "CA1", CallStatus: "completed", CallDuration: "42" }).durationSeconds).toBe(42);
  });
});
