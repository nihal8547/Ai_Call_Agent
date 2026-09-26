import { type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AgentConfig, type AgentConfigInput } from "@platform/shared";
import { instantiateTemplate } from "@platform/templates";
import { twilioSignature } from "@platform/telephony";
import { randomInt } from "node:crypto";
import { TenantDbService } from "../../src/infra/tenant-db.service";
import { PUBLIC_URL, TWILIO_TOKEN } from "./app";

/** Give a tenant an active agent with a published config and a phone number */
export async function provisionAgent(
  app: NestFastifyApplication,
  tenantId: string,
  template: string,
  overrides: Partial<AgentConfigInput> = {},
) {
  const config = AgentConfig.parse({ ...instantiateTemplate(template), ...overrides });
  const e164 = `+9180${randomInt(10_000_000, 99_999_999)}`;
  return app.get(TenantDbService).tx(tenantId, async (tx) => {
    const agent = await tx.agent.create({
      data: { tenantId, name: `${template} ${e164}`, status: "ACTIVE", templateKey: template },
    });
    const version = await tx.agentVersion.create({
      data: {
        tenantId,
        agentId: agent.id,
        version: 1,
        status: "PUBLISHED",
        config,
        configHash: "test",
        publishedAt: new Date(),
      },
    });
    await tx.agent.update({ where: { id: agent.id }, data: { publishedVersionId: version.id } });
    await tx.phoneNumber.create({ data: { tenantId, agentId: agent.id, e164 } });
    return { agentId: agent.id, versionId: version.id, e164, config };
  });
}

type TwimlResponse = {
  status: number;
  xml: string;
  say: string;
  next: string | null;
  dial: string | null;
  hangup: boolean;
};

export function parseTwiml(status: number, xml: string): TwimlResponse {
  const unescape = (s: string) =>
    s
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  const action = /<Gather[^>]* action="([^"]+)"/.exec(xml)?.[1];
  return {
    status,
    xml,
    say: unescape(/<Say[^>]*>([\s\S]*?)<\/Say>/.exec(xml)?.[1] ?? ""),
    next: action ? unescape(action).replace(PUBLIC_URL, "") : null,
    dial: /<Number>([^<]+)<\/Number>/.exec(xml)?.[1] ?? null,
    hangup: xml.includes("<Hangup/>"),
  };
}

/** Post a webhook exactly as Twilio would: form-encoded and signed */
export async function twilioPost(
  app: NestFastifyApplication,
  path: string,
  params: Record<string, string>,
  opts: { token?: string; signature?: string | null } = {},
) {
  const signature =
    opts.signature === undefined
      ? twilioSignature(opts.token ?? TWILIO_TOKEN, `${PUBLIC_URL}${path}`, params)
      : opts.signature;
  const res = await app.inject({
    method: "POST",
    url: path,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(signature ? { "x-twilio-signature": signature } : {}),
    },
    payload: new URLSearchParams(params).toString(),
    remoteAddress: "54.172.60.1",
  });
  return { res, twiml: parseTwiml(res.statusCode, res.body) };
}

/** Simulate a phone call: dial in, then speak each line; returns every agent reply */
export async function phoneCall(
  app: NestFastifyApplication,
  to: string,
  lines: string[],
  callSid = `CA${randomInt(1e9, 9e9)}${Date.now()}`,
  overrides: Record<string, string> = {},
) {
  const base = { CallSid: callSid, From: "+919812345678", To: to, CallStatus: "in-progress", ...overrides };
  const replies: TwimlResponse[] = [];
  let r = await twilioPost(app, "/telephony/twilio/voice", base);
  replies.push(r.twiml);
  for (const line of lines) {
    if (!r.twiml.next) break;
    r = await twilioPost(app, r.twiml.next, { ...base, SpeechResult: line, Confidence: "0.92" });
    replies.push(r.twiml);
  }
  return { callSid, replies, last: replies[replies.length - 1]!, base };
}
