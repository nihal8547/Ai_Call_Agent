import { HttpStatus, Injectable } from "@nestjs/common";
import { parsePhone } from "@platform/core";
import { Prisma, type TenantTx } from "@platform/db";
import {
  AgentConfig,
  type BuyTwilioNumberBody,
  type ConnectForwardingBody,
  type CreatePhoneNumberBody,
} from "@platform/shared";
import { type Carrier, forwardingInstructions, type ForwardingMode } from "@platform/telephony";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { AppException } from "../../common/filters/problem-details.filter";
import { PrismaService } from "../../infra/prisma.service";
import { TenantDbService } from "../../infra/tenant-db.service";
import { TwilioRestService } from "../../infra/twilio-rest.service";
import { AuditService } from "../audit/audit.service";

type Meta = { ip?: string; userAgent?: string };
const VERIFY_WINDOW_MS = 10 * 60_000;

export const PHONE_NUMBER_VIEW = {
  id: true,
  e164: true,
  provider: true,
  providerSid: true,
  friendlyName: true,
  isActive: true,
  forwardedFrom: true,
  carrier: true,
  forwardingMode: true,
  verificationStatus: true,
  verificationExpiresAt: true,
  verifiedAt: true,
  verification: true,
  maxConcurrentCalls: true,
  lastCallAt: true,
  createdAt: true,
  agent: { select: { id: true, name: true, status: true } },
  sipTrunk: { select: { id: true, name: true, domainName: true, status: true } },
} as const;

const notFound = () => new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Phone number not found");
const invalid = (path: string, message: string) =>
  new AppException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", message, [{ path, message }]);

/**
 * The numbers callers reach an agent on: Twilio numbers (bought here, or added by the platform
 * operator), the business's existing line forwarded to one of them, and numbers on a SIP trunk.
 */
@Injectable()
export class PhoneNumbersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDbService,
    private readonly twilio: TwilioRestService,
    private readonly audit: AuditService,
  ) {}

  list(tenantId: string) {
    return this.tenantDb
      .db(tenantId)
      .phoneNumber.findMany({ select: PHONE_NUMBER_VIEW, orderBy: { createdAt: "asc" } });
  }

  async callingCode(tx: TenantTx, tenantId: string): Promise<string> {
    return (await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { callingCode: true } }))
      .callingCode;
  }

  /** Staff typed a number: E.164, or local digits in the business's own country */
  parse(input: string, callingCode: string, path: string): string {
    const e164 = parsePhone(input, callingCode);
    if (!e164) throw invalid(path, "Enter the full number, e.g. +974 4412 3456");
    return e164;
  }

  /**
   * Add a Twilio number by hand. With the platform's Twilio account configured, only platform
   * operators may: businesses buy numbers, so nobody can claim a number they don't pay for.
   */
  async addManual(auth: AuthContext, body: z.output<typeof CreatePhoneNumberBody>, meta: Meta) {
    if (this.twilio.client && !(await this.isPlatformOwner(auth)))
      throw new AppException(
        HttpStatus.FORBIDDEN,
        "FORBIDDEN",
        "Buy a number here, or ask the platform operator to add yours.",
      );
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      if (body.agentId) await assertAgent(tx, body.agentId);
      const number = await this.createNumber(tx, {
        tenantId: auth.tenantId,
        e164: body.e164,
        friendlyName: body.friendlyName ?? null,
        agentId: body.agentId ?? null,
        providerSid: body.providerSid ?? null,
      });
      await this.audit.record(tx, auth, {
        action: "phone_number.added",
        entityType: "phone_number",
        entityId: number.id,
        after: body,
        ...meta,
      });
      return number;
    });
  }

  async searchTwilio(q: {
    country: string;
    type: "local" | "mobile" | "toll_free";
    contains?: string | undefined;
  }) {
    try {
      return await this.twilio
        .require()
        .searchNumbers({ ...q, ...(q.contains ? { contains: q.contains } : {}), limit: 20 });
    } catch (err) {
      if (err instanceof AppException) throw err;
      throw TwilioRestService.toProblem(err, "Searching numbers");
    }
  }

  /** Buy a Twilio number (it costs money every month: owners only) and point it at the agents */
  async buyTwilio(auth: AuthContext, body: z.output<typeof BuyTwilioNumberBody>, meta: Meta) {
    const client = this.twilio.require();
    if (body.agentId) await this.tenantDb.tx(auth.tenantId, (tx) => assertAgent(tx, body.agentId!));
    let bought;
    try {
      bought = await client.buyNumber({
        phoneNumber: body.phoneNumber,
        ...this.twilio.webhooks,
        friendlyName: (body.friendlyName ?? body.phoneNumber).slice(0, 64),
      });
    } catch (err) {
      throw TwilioRestService.toProblem(err, "Buying the number");
    }
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const number = await this.createNumber(tx, {
        tenantId: auth.tenantId,
        e164: bought.phoneNumber,
        friendlyName: body.friendlyName ?? null,
        agentId: body.agentId ?? null,
        providerSid: bought.sid,
      });
      await this.audit.record(tx, auth, {
        action: "phone_number.bought",
        entityType: "phone_number",
        entityId: number.id,
        after: { e164: bought.phoneNumber, sid: bought.sid },
        ...meta,
      });
      return number;
    });
  }

  /** Remove a number; a number bought here is released back to Twilio (billing stops) */
  async remove(auth: AuthContext, id: string, release: boolean, meta: Meta): Promise<void> {
    const number = await this.tenantDb.db(auth.tenantId).phoneNumber.findUnique({ where: { id } });
    if (!number) throw notFound();
    if (release && number.provider === "TWILIO" && number.providerSid && this.twilio.client) {
      try {
        await this.twilio.client.releaseNumber(number.providerSid);
      } catch (err) {
        throw TwilioRestService.toProblem(err, "Releasing the number");
      }
    }
    await this.tenantDb.tx(auth.tenantId, async (tx) => {
      await tx.phoneNumber.delete({ where: { id } });
      await this.audit.record(tx, auth, {
        action: release ? "phone_number.released" : "phone_number.removed",
        entityType: "phone_number",
        entityId: id,
        before: { e164: number.e164, forwardedFrom: number.forwardedFrom },
        ...meta,
      });
    });
  }

  // ── The business's existing line, forwarded ─────────────────────────────────
  async connectForwarding(
    auth: AuthContext,
    id: string,
    body: z.output<typeof ConnectForwardingBody>,
    meta: Meta,
  ) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const number = await tx.phoneNumber.findUnique({
        where: { id },
        include: { agent: { include: { publishedVersion: true } } },
      });
      if (!number) throw notFound();
      if (number.provider !== "TWILIO")
        throw invalid("id", "Forwarding goes to a Twilio number; SIP numbers are connected on their trunk");
      const business = this.parse(
        body.businessNumber,
        await this.callingCode(tx, auth.tenantId),
        "businessNumber",
      );
      if (business === number.e164)
        throw invalid("businessNumber", "Enter the number customers call now, not this one");
      assertNoTransferLoop(number.agent?.publishedVersion?.config, business);
      const updated = await tx.phoneNumber
        .update({
          where: { id },
          data: {
            forwardedFrom: business,
            carrier: body.carrier,
            forwardingMode: body.mode,
            verificationStatus: "NONE",
            verificationExpiresAt: null,
            verifiedAt: null,
            verification: {},
          },
          select: PHONE_NUMBER_VIEW,
        })
        .catch((err: unknown) => {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
            throw new AppException(HttpStatus.CONFLICT, "CONFLICT", "That number is already connected", [
              { path: "businessNumber", message: "Already connected to an agent" },
            ]);
          throw err;
        });
      await this.audit.record(tx, auth, {
        action: "phone_number.forwarding_connected",
        entityType: "phone_number",
        entityId: id,
        after: { businessNumber: business, carrier: body.carrier, mode: body.mode },
        ...meta,
      });
      return { number: updated, instructions: forwardingInstructions(number.e164, body.mode, body.carrier) };
    });
  }

  async instructions(tenantId: string, id: string) {
    const n = await this.tenantDb.db(tenantId).phoneNumber.findUnique({ where: { id } });
    if (!n) throw notFound();
    if (!n.forwardedFrom) throw invalid("id", "No existing number is connected to this one");
    return forwardingInstructions(
      n.e164,
      (n.forwardingMode ?? "NO_ANSWER_BUSY_UNREACHABLE") as ForwardingMode,
      (n.carrier ?? "other") as Carrier,
    );
  }

  async disconnectForwarding(auth: AuthContext, id: string, meta: Meta) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const n = await tx.phoneNumber.findUnique({ where: { id } });
      if (!n) throw notFound();
      const updated = await tx.phoneNumber.update({
        where: { id },
        data: {
          forwardedFrom: null,
          carrier: null,
          forwardingMode: null,
          verificationStatus: "NONE",
          verificationExpiresAt: null,
          verifiedAt: null,
          verification: {},
        },
        select: PHONE_NUMBER_VIEW,
      });
      await this.audit.record(tx, auth, {
        action: "phone_number.forwarding_disconnected",
        entityType: "phone_number",
        entityId: id,
        before: { businessNumber: n.forwardedFrom },
        ...meta,
      });
      return { number: updated, disable: n.forwardingMode === "ALL" ? "##21#" : "##004#" };
    });
  }

  /** Open a 10-minute window: the next call (from `from`, if given) proves the route works */
  async startVerification(auth: AuthContext, id: string, from: string | undefined) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const n = await tx.phoneNumber.findUnique({ where: { id } });
      if (!n) throw notFound();
      const expectFrom = from
        ? this.parse(from, await this.callingCode(tx, auth.tenantId), "from")
        : undefined;
      return tx.phoneNumber.update({
        where: { id },
        data: {
          verificationStatus: "PENDING",
          verificationExpiresAt: new Date(Date.now() + VERIFY_WINDOW_MS),
          verification: expectFrom ? { expectFrom } : {},
        },
        select: PHONE_NUMBER_VIEW,
      });
    });
  }

  /** Numbers the verification window has passed without a call become FAILED when read */
  async expireVerifications(tenantId: string): Promise<void> {
    await this.tenantDb.db(tenantId).phoneNumber.updateMany({
      where: { verificationStatus: "PENDING", verificationExpiresAt: { lt: new Date() } },
      data: { verificationStatus: "FAILED" },
    });
  }

  async createNumber(
    tx: TenantTx,
    data: {
      tenantId: string;
      e164: string;
      friendlyName: string | null;
      agentId: string | null;
      providerSid: string | null;
      provider?: "TWILIO" | "SIP";
      sipTrunkId?: string;
    },
  ) {
    return tx.phoneNumber.create({ data, select: PHONE_NUMBER_VIEW }).catch((err: unknown) => {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
        throw new AppException(HttpStatus.CONFLICT, "CONFLICT", "This number is already in use", [
          { path: "e164", message: "Already in use" },
        ]);
      throw err;
    });
  }

  private async isPlatformOwner(auth: AuthContext): Promise<boolean> {
    if (auth.kind !== "user") return false;
    const user = await this.prisma.client.user.findUnique({
      where: { id: auth.userId },
      select: { isPlatformOwner: true },
    });
    return Boolean(user?.isPlatformOwner);
  }
}

export async function assertAgent(tx: TenantTx, agentId: string): Promise<void> {
  // RLS makes another tenant's agent invisible, so it reads as unknown
  if (!(await tx.agent.count({ where: { id: agentId } }))) throw invalid("agentId", "Unknown agent");
}

/** The agent must not transfer callers to the very line that forwards to it */
export function assertNoTransferLoop(config: unknown, businessNumber: string): void {
  if (!config) return;
  const parsed = AgentConfig.safeParse(config);
  const to = parsed.success && parsed.data.handoff.enabled ? parsed.data.handoff.phoneNumber : null;
  if (to && to.replace(/[^\d+]/g, "") === businessNumber)
    throw invalid(
      "businessNumber",
      "This agent transfers callers to this same number, which would forward them straight back. Give the agent a different staff number for transfers first.",
    );
}
