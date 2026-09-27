import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { randomToken } from "@platform/crypto";
import type { SipTrunk } from "@platform/db";
import type { AddSipNumberBody, CreateSipTrunkBody, UpdateSipTrunkBody } from "@platform/shared";
import { validTrunkCidr } from "@platform/telephony";
import { randomBytes } from "node:crypto";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { AppException } from "../../common/filters/problem-details.filter";
import { TenantDbService } from "../../infra/tenant-db.service";
import { TenantKeysService } from "../../infra/tenant-keys.service";
import { TwilioRestService } from "../../infra/twilio-rest.service";
import { AuditService } from "../audit/audit.service";
import { assertAgent, PhoneNumbersService } from "./phone-numbers.service";

type Meta = { ip?: string; userAgent?: string };

export const SIP_DOMAIN_SUFFIX = "sip.twilio.com";
const VIEW = {
  id: true,
  name: true,
  carrier: true,
  domainName: true,
  allowedIps: true,
  authUsername: true,
  status: true,
  lastError: true,
  lastCallAt: true,
  createdAt: true,
  _count: { select: { numbers: true } },
} as const;

const invalid = (path: string, message: string) =>
  new AppException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", message, [{ path, message }]);
const notFound = () => new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "SIP connection not found");

/** Twilio needs 12+ characters with upper and lower case letters and a digit */
function sipPassword(): string {
  return `Sip${randomToken(18).replace(/[^A-Za-z0-9]/g, "")}9a`;
}

/**
 * SIP connections from a business's carrier or PBX (Ooredoo SIP-T, Vodafone business SIP, a PBX).
 * Each gets its own Twilio SIP domain that only accepts calls from its signalling addresses (and,
 * optionally, a username and password); calls to its numbers reach the agents like any other.
 */
@Injectable()
export class SipTrunksService {
  private readonly logger = new Logger(SipTrunksService.name);

  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly keys: TenantKeysService,
    private readonly twilio: TwilioRestService,
    private readonly numbers: PhoneNumbersService,
    private readonly audit: AuditService,
  ) {}

  list(tenantId: string) {
    return this.tenantDb.db(tenantId).sipTrunk.findMany({ select: VIEW, orderBy: { createdAt: "asc" } });
  }

  private checkIps(ips: string[]): string[] {
    const cleaned = [...new Set(ips.map((i) => i.trim()).filter(Boolean))];
    const bad = cleaned.find((ip) => !validTrunkCidr(ip));
    if (bad)
      throw invalid(
        "allowedIps",
        `${bad} is not a public IPv4 address or range (/16 or narrower). Ask your carrier for its SIP signalling addresses.`,
      );
    return cleaned;
  }

  async create(auth: AuthContext, body: z.output<typeof CreateSipTrunkBody>, meta: Meta) {
    const allowedIps = this.checkIps(body.allowedIps);
    if (!allowedIps.length && !body.useCredentials)
      throw invalid("allowedIps", "Add your carrier's signalling addresses, or use a username and password (or both)");
    const tenant = await this.tenantDb.db(auth.tenantId).tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { slug: true } });
    const domainName = `${tenant.slug.replace(/[^a-z0-9]/g, "").slice(0, 20) || "biz"}-${randomBytes(3).toString("hex")}`;
    const password = body.useCredentials ? sipPassword() : null;
    const created = await this.tenantDb.tx(auth.tenantId, async (tx) => {
      if (await tx.sipTrunk.count({ where: { name: body.name } }))
        throw new AppException(HttpStatus.CONFLICT, "CONFLICT", "A SIP connection with this name exists", [
          { path: "name", message: "Name already used" },
        ]);
      const row = await tx.sipTrunk.create({
        data: {
          tenantId: auth.tenantId,
          name: body.name,
          carrier: body.carrier,
          domainName,
          allowedIps,
          authUsername: password ? domainName.slice(0, 32) : null,
        },
      });
      if (password)
        await tx.sipTrunk.update({
          where: { id: row.id },
          data: { authSecretEnc: await this.keys.seal(auth.tenantId, `sip:${row.id}`, { password }) },
        });
      await this.audit.record(tx, auth, {
        action: "sip_trunk.created",
        entityType: "sip_trunk",
        entityId: row.id,
        after: { name: body.name, carrier: body.carrier, allowedIps, credentials: Boolean(password) },
        ...meta,
      });
      return row;
    });
    const trunk = await this.provision(auth.tenantId, created, password);
    return { trunk, sipDomain: `${domainName}.${SIP_DOMAIN_SUFFIX}`, ...(password ? { password } : {}) };
  }

  /** Create the Twilio side; without a platform Twilio account the trunk waits for the operator */
  private async provision(tenantId: string, trunk: SipTrunk, password: string | null) {
    const db = this.tenantDb.db(tenantId);
    const client = this.twilio.client;
    if (!client) return db.sipTrunk.findUniqueOrThrow({ where: { id: trunk.id }, select: VIEW });
    try {
      const domain = trunk.twilioDomainSid
        ? { sid: trunk.twilioDomainSid }
        : await client.createSipDomain({
            domainName: `${trunk.domainName}.${SIP_DOMAIN_SUFFIX}`,
            friendlyName: trunk.name,
            ...this.twilio.webhooks,
          });
      await db.sipTrunk.update({ where: { id: trunk.id }, data: { twilioDomainSid: domain.sid } });
      const acl =
        trunk.twilioIpAclSid ??
        (trunk.allowedIps.length ? await client.createIpAcl(domain.sid, trunk.name, trunk.allowedIps) : null);
      const creds =
        trunk.twilioCredListSid ??
        (password && trunk.authUsername
          ? await client.createCredentials(domain.sid, trunk.name, trunk.authUsername, password)
          : null);
      return db.sipTrunk.update({
        where: { id: trunk.id },
        data: { twilioIpAclSid: acl, twilioCredListSid: creds, status: "ACTIVE", lastError: null },
        select: VIEW,
      });
    } catch (err) {
      const message = TwilioRestService.toProblem(err, "Creating the SIP domain").message;
      this.logger.warn({ err, trunkId: trunk.id }, "SIP domain provisioning failed");
      return db.sipTrunk.update({
        where: { id: trunk.id },
        data: { status: "ERROR", lastError: String(message).slice(0, 500) },
        select: VIEW,
      });
    }
  }

  /** Try the Twilio side again (after fixing the platform's Twilio account) */
  async reprovision(tenantId: string, id: string) {
    const trunk = await this.tenantDb.db(tenantId).sipTrunk.findUnique({ where: { id } });
    if (!trunk) throw notFound();
    this.twilio.require();
    const password =
      trunk.authSecretEnc && !trunk.twilioCredListSid
        ? (await this.keys.open<{ password: string }>(tenantId, `sip:${id}`, trunk.authSecretEnc)).password
        : null;
    return this.provision(tenantId, trunk, password);
  }

  async update(auth: AuthContext, id: string, body: z.output<typeof UpdateSipTrunkBody>, meta: Meta) {
    const trunk = await this.tenantDb.db(auth.tenantId).sipTrunk.findUnique({ where: { id } });
    if (!trunk) throw notFound();
    const allowedIps = body.allowedIps ? this.checkIps(body.allowedIps) : undefined;
    if (allowedIps && !allowedIps.length && !trunk.authUsername)
      throw invalid("allowedIps", "A connection without a password needs at least one address");
    if (allowedIps && this.twilio.client && trunk.twilioDomainSid) {
      try {
        if (trunk.twilioIpAclSid) await this.twilio.client.setIpAclAddresses(trunk.twilioIpAclSid, allowedIps);
        else if (allowedIps.length) {
          const acl = await this.twilio.client.createIpAcl(trunk.twilioDomainSid, trunk.name, allowedIps);
          await this.tenantDb.db(auth.tenantId).sipTrunk.update({ where: { id }, data: { twilioIpAclSid: acl } });
        }
      } catch (err) {
        throw TwilioRestService.toProblem(err, "Updating the allowed addresses");
      }
    }
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const row = await tx.sipTrunk.update({
        where: { id },
        data: {
          ...(body.name ? { name: body.name } : {}),
          ...(allowedIps ? { allowedIps } : {}),
          ...(body.status ? { status: body.status } : {}),
        },
        select: VIEW,
      });
      await this.audit.record(tx, auth, { action: "sip_trunk.updated", entityType: "sip_trunk", entityId: id, after: body, ...meta });
      return row;
    });
  }

  async remove(auth: AuthContext, id: string, meta: Meta): Promise<void> {
    const db = this.tenantDb.db(auth.tenantId);
    const trunk = await db.sipTrunk.findUnique({ where: { id }, include: { _count: { select: { numbers: true } } } });
    if (!trunk) throw notFound();
    if (trunk._count.numbers)
      throw new AppException(HttpStatus.CONFLICT, "CONFLICT", "Remove this connection's numbers first");
    const client = this.twilio.client;
    if (client) {
      // Best effort: a resource already deleted in the Twilio console is fine
      for (const [sid, del] of [
        [trunk.twilioDomainSid, (s: string) => client.deleteSipDomain(s)],
        [trunk.twilioIpAclSid, (s: string) => client.deleteIpAcl(s)],
        [trunk.twilioCredListSid, (s: string) => client.deleteCredentialList(s)],
      ] as const)
        if (sid) await del(sid).catch((err: unknown) => this.logger.warn({ err, sid }, "Twilio cleanup failed"));
    }
    await this.tenantDb.tx(auth.tenantId, async (tx) => {
      await tx.sipTrunk.delete({ where: { id } });
      await this.audit.record(tx, auth, { action: "sip_trunk.deleted", entityType: "sip_trunk", entityId: id, before: { name: trunk.name }, ...meta });
    });
  }

  /** A number customers dial that arrives on this trunk (the carrier sends it in the SIP To) */
  async addNumber(auth: AuthContext, id: string, body: z.output<typeof AddSipNumberBody>, meta: Meta) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const trunk = await tx.sipTrunk.findUnique({ where: { id } });
      if (!trunk) throw notFound();
      if (body.agentId) await assertAgent(tx, body.agentId);
      const e164 = this.numbers.parse(body.number, await this.numbers.callingCode(tx, auth.tenantId), "number");
      const number = await this.numbers.createNumber(tx, {
        tenantId: auth.tenantId,
        e164,
        friendlyName: body.friendlyName ?? null,
        agentId: body.agentId ?? null,
        providerSid: null,
        provider: "SIP",
        sipTrunkId: id,
      });
      await this.audit.record(tx, auth, { action: "phone_number.added", entityType: "phone_number", entityId: number.id, after: { e164, sipTrunkId: id }, ...meta });
      return number;
    });
  }

  /** Everything the carrier or PBX vendor needs, as a sheet to send them */
  async setupSheet(tenantId: string, id: string) {
    const trunk = await this.tenantDb.db(tenantId).sipTrunk.findUnique({ where: { id }, include: { numbers: { select: { e164: true } } } });
    if (!trunk) throw notFound();
    const domain = `${trunk.domainName}.${SIP_DOMAIN_SUFFIX}`;
    const sheet = {
      sipDomain: domain,
      uris: trunk.numbers.length ? trunk.numbers.map((n) => `sip:${n.e164}@${domain}`) : [`sip:<dialled number in +974 format>@${domain}`],
      transport: "TLS on port 5061 (preferred), or TCP/UDP on 5060",
      media: "SRTP with TLS; RTP otherwise",
      codecs: "G.711 A-law (PCMA) and G.711 μ-law (PCMU)",
      dialledNumber: "Put the number the customer dialled in the Request-URI / To, in E.164 (+974…)",
      callerNumber: "Put the customer's number in From or P-Asserted-Identity, in E.164",
      allowedSourceIps: trunk.allowedIps,
      authentication: trunk.authUsername
        ? `Digest username ${trunk.authUsername} (the password was shown once when the connection was created)`
        : "By source IP address only",
      twilioAddresses: "Allow Twilio's SIP signalling and media address ranges in your firewall (listed in Twilio's “IP addresses” documentation for SIP)",
      status: trunk.status,
    };
    const text = [
      `SIP connection for ${trunk.name}`,
      "",
      `SIP domain:        ${sheet.sipDomain}`,
      `Send calls to:     ${sheet.uris.join("\n                   ")}`,
      `Transport:         ${sheet.transport}`,
      `Media:             ${sheet.media}`,
      `Codecs:            ${sheet.codecs}`,
      `Dialled number:    ${sheet.dialledNumber}`,
      `Caller number:     ${sheet.callerNumber}`,
      `Allowed from:      ${sheet.allowedSourceIps.join(", ") || "(credentials only)"}`,
      `Authentication:    ${sheet.authentication}`,
      `Firewall:          ${sheet.twilioAddresses}`,
    ].join("\n");
    return { ...sheet, text };
  }
}
