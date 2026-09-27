import { Injectable } from "@nestjs/common";
import { parsePhone } from "@platform/core";
import { resolvePhoneNumber, resolveSipTrunk } from "@platform/db";
import { type InboundCall, parseSipUri, sipDomainLabel } from "@platform/telephony";
import { PrismaService } from "../../infra/prisma.service";
import { TenantDbService } from "../../infra/tenant-db.service";

export type CallRoute = {
  tenantId: string;
  phoneNumberId: string;
  agentId: string | null;
  agentVersionId: string | null;
  /** TWILIO: dialled the Twilio number; FORWARDED: the business line forwarded it; SIP: via a trunk */
  connection: "TWILIO" | "FORWARDED" | "SIP";
  /** The number the caller dialled, as the business knows it */
  dialled: string;
  /** Caller's number in E.164 when it can be read, else what the carrier sent */
  callerNumber: string;
  forwardedFrom: string | null;
  sipTrunkId: string | null;
  /** Never transfer to this number: it would come straight back to the agent */
  businessNumber: string | null;
  verificationPending: { from: string | null } | null;
  maxConcurrentCalls: number | null;
};

/**
 * Finds whose call this is. A Twilio number is looked up by the webhook's `To`; a SIP call by the
 * SIP domain it arrived on (one per business trunk), then by the dialled number on that trunk.
 */
@Injectable()
export class CallRouter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDbService,
  ) {}

  async route(call: InboundCall, callingCode: (tenantId: string) => Promise<string>): Promise<CallRoute | null> {
    const sipTo = parseSipUri(call.to);
    return sipTo ? this.sip(call, sipTo, callingCode) : this.twilio(call, callingCode);
  }

  private async twilio(call: InboundCall, callingCode: (t: string) => Promise<string>): Promise<CallRoute | null> {
    const r = await resolvePhoneNumber(this.prisma.client, call.to);
    if (!r) return null;
    const number = await this.tenantDb.db(r.tenantId).phoneNumber.findUniqueOrThrow({ where: { id: r.phoneNumberId } });
    const code = await callingCode(r.tenantId);
    const forwardedFrom = call.forwardedFrom ? (parsePhone(call.forwardedFrom, code) ?? call.forwardedFrom) : null;
    return {
      tenantId: r.tenantId,
      phoneNumberId: r.phoneNumberId,
      agentId: r.agentId,
      agentVersionId: r.agentVersionId,
      connection: forwardedFrom ? "FORWARDED" : "TWILIO",
      dialled: number.forwardedFrom ?? number.e164,
      callerNumber: callerE164(call.from, code),
      forwardedFrom,
      sipTrunkId: null,
      businessNumber: number.forwardedFrom,
      verificationPending: pending(number),
      maxConcurrentCalls: number.maxConcurrentCalls,
    };
  }

  private async sip(
    call: InboundCall,
    to: { user: string; host: string },
    callingCode: (t: string) => Promise<string>,
  ): Promise<CallRoute | null> {
    const label = sipDomainLabel(to.host);
    if (!label) return null;
    const trunk = await resolveSipTrunk(this.prisma.client, label);
    if (!trunk) return null;
    const dialled = parsePhone(to.user, trunk.callingCode);
    if (!dialled) return null;
    const db = this.tenantDb.db(trunk.tenantId);
    const number = await db.phoneNumber.findFirst({
      where: { e164: dialled, sipTrunkId: trunk.sipTrunkId, isActive: true },
      include: { agent: { select: { id: true, status: true, publishedVersionId: true } } },
    });
    await db.sipTrunk.update({ where: { id: trunk.sipTrunkId }, data: { lastCallAt: new Date() } });
    if (!number) return null;
    const active = number.agent?.status === "ACTIVE" ? number.agent : null;
    const fromUri = parseSipUri(call.from);
    return {
      tenantId: trunk.tenantId,
      phoneNumberId: number.id,
      agentId: active?.id ?? null,
      agentVersionId: active?.publishedVersionId ?? null,
      connection: "SIP",
      dialled,
      callerNumber: callerE164(fromUri?.user ?? call.from, await callingCode(trunk.tenantId)),
      forwardedFrom: null,
      sipTrunkId: trunk.sipTrunkId,
      businessNumber: dialled,
      verificationPending: pending(number),
      maxConcurrentCalls: number.maxConcurrentCalls,
    };
  }
}

function pending(n: { verificationStatus: string; verificationExpiresAt: Date | null; verification: unknown }) {
  return n.verificationStatus === "PENDING" && n.verificationExpiresAt && n.verificationExpiresAt > new Date()
    ? { from: ((n.verification ?? {}) as { expectFrom?: string }).expectFrom ?? null }
    : null;
}

/** Withheld or odd caller IDs are kept as sent ("anonymous", "+266696687") */
function callerE164(raw: string, callingCode: string): string {
  return parsePhone(raw, callingCode) ?? raw.slice(0, 20);
}
