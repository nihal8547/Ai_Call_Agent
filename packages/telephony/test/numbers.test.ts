import { describe, expect, it } from "vitest";
import {
  forwardingInstructions,
  parseSipUri,
  renderTwiml,
  sipDomainLabel,
  TwilioAdapter,
  TwilioRest,
  TwilioRestError,
  validTrunkCidr,
} from "../src";

type Seen = { method: string; url: string; auth: string; body: Record<string, string> };

function fakeTwilio(answers: ((r: Seen) => Response)[]) {
  const seen: Seen[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const r: Seen = {
      method: init.method ?? "GET",
      url: String(input),
      auth: String((init.headers as Record<string, string>).authorization),
      body: init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : {},
    };
    seen.push(r);
    const next = answers.shift();
    if (!next) throw new Error(`unexpected ${r.method} ${r.url}`);
    return next(r);
  }) as typeof fetch;
  const rest = new TwilioRest({ accountSid: "AC123", username: "SKkey", password: "secret", fetch: f });
  return { rest, seen };
}

describe("Twilio numbers", () => {
  it("searches numbers that can take voice calls, by country and type", async () => {
    const t = fakeTwilio([
      () =>
        Response.json({
          available_phone_numbers: [
            {
              phone_number: "+97444001122",
              friendly_name: "+974 4400 1122",
              locality: "",
              region: "Doha",
              iso_country: "QA",
              capabilities: { voice: true, SMS: false },
              address_requirements: "local",
            },
          ],
        }),
    ]);
    const found = await t.rest.searchNumbers({ country: "QA", type: "local", contains: "44" });
    expect(found).toEqual([
      {
        phoneNumber: "+97444001122",
        friendlyName: "+974 4400 1122",
        locality: null,
        region: "Doha",
        isoCountry: "QA",
        capabilities: { voice: true, sms: false },
        addressRequirements: "local",
      },
    ]);
    expect(t.seen[0]!.url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC123/AvailablePhoneNumbers/QA/Local.json?VoiceEnabled=true&PageSize=20&Contains=44",
    );
    expect(t.seen[0]!.auth).toBe(`Basic ${Buffer.from("SKkey:secret").toString("base64")}`);
  });

  it("buys a number already pointed at the platform's webhooks", async () => {
    const t = fakeTwilio([
      () =>
        Response.json(
          {
            sid: "PN1",
            phone_number: "+15005550006",
            friendly_name: "Front desk",
            voice_url: "https://voice.test/telephony/twilio/voice",
          },
          { status: 201 },
        ),
    ]);
    const n = await t.rest.buyNumber({
      phoneNumber: "+15005550006",
      voiceUrl: "https://voice.test/telephony/twilio/voice",
      statusCallback: "https://voice.test/telephony/twilio/status",
      friendlyName: "Front desk",
    });
    expect(n).toEqual({
      sid: "PN1",
      phoneNumber: "+15005550006",
      friendlyName: "Front desk",
      voiceUrl: "https://voice.test/telephony/twilio/voice",
    });
    expect(t.seen[0]).toMatchObject({
      method: "POST",
      url: "https://api.twilio.com/2010-04-01/Accounts/AC123/IncomingPhoneNumbers.json",
      body: {
        PhoneNumber: "+15005550006",
        VoiceUrl: "https://voice.test/telephony/twilio/voice",
        VoiceMethod: "POST",
        StatusCallback: "https://voice.test/telephony/twilio/status",
        FriendlyName: "Front desk",
      },
    });
  });

  it("reports Twilio's own error message", async () => {
    const t = fakeTwilio([
      () => Response.json({ code: 21422, message: "PhoneNumber is not available" }, { status: 400 }),
    ]);
    await expect(
      t.rest.buyNumber({ phoneNumber: "+15005550000", voiceUrl: "x", statusCallback: "y" }),
    ).rejects.toEqual(new TwilioRestError(400, 21422, "Twilio: PhoneNumber is not available"));
  });
});

describe("SIP domains for business trunks", () => {
  it("creates a domain, an IP allow-list and credentials, each mapped to the domain", async () => {
    const t = fakeTwilio([
      () => Response.json({ sid: "SD1", domain_name: "acme-1a2b.sip.twilio.com" }, { status: 201 }),
      () => Response.json({ sid: "AL1" }, { status: 201 }),
      () => Response.json({ ip_addresses: [{ sid: "IPold" }] }),
      () => new Response(null, { status: 204 }),
      () => Response.json({ sid: "IP1" }, { status: 201 }),
      () => Response.json({ sid: "IP2" }, { status: 201 }),
      () => Response.json({ sid: "MP1" }, { status: 201 }),
      () => Response.json({ sid: "CL1" }, { status: 201 }),
      () => Response.json({ sid: "CR1" }, { status: 201 }),
      () => Response.json({ sid: "MP2" }, { status: 201 }),
    ]);
    const domain = await t.rest.createSipDomain({
      domainName: "acme-1a2b.sip.twilio.com",
      friendlyName: "Ooredoo SIP-T",
      voiceUrl: "https://voice.test/telephony/twilio/voice",
      statusCallback: "https://voice.test/telephony/twilio/status",
    });
    expect(domain).toEqual({ sid: "SD1", domainName: "acme-1a2b.sip.twilio.com" });
    expect(t.seen[0]!.body).toMatchObject({
      DomainName: "acme-1a2b.sip.twilio.com",
      VoiceUrl: "https://voice.test/telephony/twilio/voice",
      Secure: "true",
    });
    expect(await t.rest.createIpAcl("SD1", "Ooredoo SIP-T", ["212.77.192.0/24", "212.77.200.10"])).toBe(
      "AL1",
    );
    expect(t.seen.slice(2, 7).map((s) => `${s.method} ${s.url.split("/Accounts/AC123")[1]}`)).toEqual([
      "GET /SIP/IpAccessControlLists/AL1/IpAddresses.json?PageSize=200",
      "DELETE /SIP/IpAccessControlLists/AL1/IpAddresses/IPold.json",
      "POST /SIP/IpAccessControlLists/AL1/IpAddresses.json",
      "POST /SIP/IpAccessControlLists/AL1/IpAddresses.json",
      "POST /SIP/Domains/SD1/Auth/Calls/IpAccessControlListMappings.json",
    ]);
    expect(t.seen[4]!.body).toMatchObject({ IpAddress: "212.77.192.0", CidrPrefixLength: "24" });
    expect(t.seen[5]!.body).toMatchObject({ IpAddress: "212.77.200.10", CidrPrefixLength: "32" });
    expect(await t.rest.createCredentials("SD1", "Ooredoo SIP-T", "acme", "Str0ngSipPassw0rd")).toBe("CL1");
    expect(t.seen[8]!.body).toEqual({ Username: "acme", Password: "Str0ngSipPassw0rd" });
    expect(t.seen[9]!.url).toContain("/SIP/Domains/SD1/Auth/Calls/CredentialListMappings.json");
  });

  it("reads the trunk and the dialled number from SIP addresses", () => {
    expect(parseSipUri("sip:+97444123456@acme-1a2b.sip.twilio.com")).toEqual({
      user: "+97444123456",
      host: "acme-1a2b.sip.twilio.com",
    });
    expect(parseSipUri("<sip:44123456@Acme-1A2B.sip.twilio.com;transport=tls>")).toEqual({
      user: "44123456",
      host: "acme-1a2b.sip.twilio.com",
    });
    expect(parseSipUri("+97444123456")).toBeNull();
    expect(sipDomainLabel("acme-1a2b.sip.twilio.com")).toBe("acme-1a2b");
    expect(sipDomainLabel("acme-1a2b.sip.us1.twilio.com")).toBe("acme-1a2b");
    expect(sipDomainLabel("acme.sip.evil.com")).toBeNull();
    expect(sipDomainLabel("sip.twilio.com.evil.com")).toBeNull();
  });

  it("accepts public signalling addresses only", () => {
    expect(validTrunkCidr("212.77.192.0/24")).toBe(true);
    expect(validTrunkCidr("185.23.4.5")).toBe(true);
    expect(validTrunkCidr("10.0.0.1")).toBe(false);
    expect(validTrunkCidr("192.168.1.0/24")).toBe(false);
    expect(validTrunkCidr("0.0.0.0/0")).toBe(false);
    expect(validTrunkCidr("8.8.8.0/8")).toBe(false);
    expect(validTrunkCidr("300.1.1.1")).toBe(false);
  });
});

describe("forwarding an existing line", () => {
  it("gives the GSM codes for 'staff first', or everything", () => {
    const staffFirst = forwardingInstructions("+15005550006", "NO_ANSWER_BUSY_UNREACHABLE", "ooredoo");
    expect(staffFirst.mobile.enable.map((s) => s.code)).toEqual([
      "**61*+15005550006**20#",
      "**67*+15005550006#",
      "**62*+15005550006#",
    ]);
    expect(staffFirst.mobile.disable).toEqual([{ label: "Stop all conditional forwarding", code: "##004#" }]);
    expect(staffFirst.landline).toContain("Ooredoo");
    const all = forwardingInstructions("+1 500 555 0006", "ALL", "vodafone_qa");
    expect(all.mobile.enable).toEqual([
      { label: "Forward every call to the agent", code: "**21*+15005550006#" },
    ]);
    expect(all.costs).toContain("Vodafone Qatar");
  });

  it("reads what the carrier passed, and can refuse a call before answering", () => {
    const call = new TwilioAdapter("token").parse({
      CallSid: "CA1",
      From: "+97455123456",
      To: "+15005550006",
      ForwardedFrom: "+97444123456",
      CallStatus: "ringing",
    });
    expect(call).toMatchObject({ forwardedFrom: "+97444123456", from: "+97455123456" });
    expect(renderTwiml({ say: "", voice: "v", language: "en", reject: "busy" })).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>',
    );
  });
});
