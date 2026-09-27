import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma, type WhatsAppNumber } from "@platform/db";
import {
  type UpdateWhatsAppNumberBody,
  type WhatsAppEmbeddedSignupBody,
  type WhatsAppManualConnectBody,
  WhatsAppNumberSettings,
} from "@platform/shared";
import { GraphClient, WhatsAppError } from "@platform/whatsapp";
import { randomInt, randomUUID } from "node:crypto";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { AppException } from "../../common/filters/problem-details.filter";
import { API_ENV, type ApiEnv } from "../../config/env";
import { TenantDbService } from "../../infra/tenant-db.service";
import { TenantKeysService } from "../../infra/tenant-keys.service";
import { AuditService } from "../audit/audit.service";

type Meta = { ip?: string; userAgent?: string };

/** What is sealed on the WHATSAPP integration row; never leaves the server */
type StoredCredentials = {
  kind: "cloud_api";
  accessToken: string;
  pin: string | null;
  via: "embedded_signup" | "manual";
};

const purpose = (integrationId: string) => `integration:${integrationId}`;

export const NUMBER_VIEW = {
  id: true,
  phoneNumberId: true,
  wabaId: true,
  displayNumber: true,
  verifiedName: true,
  status: true,
  qualityRating: true,
  lastError: true,
  connectedAt: true,
  settings: true,
  agent: { select: { id: true, name: true, status: true } },
} as const;

/** Meta's error, said so a business owner can act on it */
export function metaProblem(err: unknown, doing: string): AppException {
  if (!(err instanceof WhatsAppError))
    return new AppException(HttpStatus.BAD_GATEWAY, "INTEGRATION_ERROR", `${doing} failed`);
  const hint =
    err.kind === "auth"
      ? " Sign in again or use a new access token."
      : err.kind === "permission"
        ? " The access token is missing WhatsApp permissions for this account."
        : "";
  const status =
    err.kind === "transient" || err.kind === "rate_limited" ? HttpStatus.BAD_GATEWAY : HttpStatus.BAD_REQUEST;
  const said = err.message.replace(/[.\s]+$/, "");
  return new AppException(
    status,
    status === HttpStatus.BAD_GATEWAY ? "INTEGRATION_ERROR" : "VALIDATION_FAILED",
    `${doing}: ${said}.${hint}`,
  );
}

/**
 * Connecting a business's WhatsApp number (Cloud API): Embedded Signup or a pasted token, then
 * verifying the number belongs to the token, subscribing the platform's app to its webhooks and
 * registering it. The token is sealed with the business's data key on a WHATSAPP integration.
 */
@Injectable()
export class WhatsAppAccountsService {
  private readonly logger = new Logger(WhatsAppAccountsService.name);
  readonly graph: GraphClient;

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly tenantDb: TenantDbService,
    private readonly keys: TenantKeysService,
    private readonly audit: AuditService,
  ) {
    this.graph = new GraphClient({
      // Resolved per call, so tests can replace the global fetch
      fetch: (...args) => fetch(...args),
      version: env.META_GRAPH_VERSION,
      baseUrl: env.META_GRAPH_BASE_URL,
      timeoutMs: 15_000,
    });
  }

  /** What the settings page needs to know about the platform's Meta app */
  get platform() {
    const e = this.env;
    return {
      embeddedSignup: Boolean(e.META_APP_ID && e.META_APP_SECRET && e.META_EMBEDDED_SIGNUP_CONFIG_ID),
      appId: e.META_APP_ID ?? null,
      configId: e.META_EMBEDDED_SIGNUP_CONFIG_ID ?? null,
      graphVersion: e.META_GRAPH_VERSION,
      webhookUrl: `${e.PUBLIC_BASE_URL}/api/v1/webhooks/whatsapp`,
      webhookReady: Boolean(e.META_APP_SECRET && e.WHATSAPP_VERIFY_TOKEN),
      /** Voice notes are transcribed and spoken with Gemini */
      speech: Boolean(e.GEMINI_API_KEY),
    };
  }

  async list(tenantId: string) {
    const numbers = await this.tenantDb.db(tenantId).whatsAppNumber.findMany({
      where: { status: { not: "DISCONNECTED" } },
      orderBy: { connectedAt: "asc" },
      select: NUMBER_VIEW,
    });
    return { platform: this.platform, numbers };
  }

  async connectEmbedded(auth: AuthContext, body: WhatsAppEmbeddedSignupBody, meta: Meta) {
    const { META_APP_ID: appId, META_APP_SECRET: secret } = this.env;
    if (!appId || !secret || !this.env.META_EMBEDDED_SIGNUP_CONFIG_ID)
      throw new AppException(
        HttpStatus.CONFLICT,
        "CONFLICT",
        "Continue with Facebook isn't set up on this platform yet. Use another way to connect, or ask the platform operator.",
      );
    let token: string;
    try {
      token = await this.graph.exchangeCode(appId, secret, body.code);
    } catch (err) {
      throw metaProblem(err, "Facebook sign-in");
    }
    return this.finishConnect(auth, { ...body, token, via: "embedded_signup" }, meta);
  }

  async connectManual(auth: AuthContext, body: WhatsAppManualConnectBody, meta: Meta) {
    return this.finishConnect(auth, { ...body, token: body.accessToken, via: "manual" }, meta);
  }

  private async finishConnect(
    auth: AuthContext,
    input: {
      token: string;
      wabaId: string;
      phoneNumberId: string;
      agentId?: string | null | undefined;
      via: StoredCredentials["via"];
    },
    meta: Meta,
  ) {
    const { token, wabaId, phoneNumberId } = input;
    if (input.agentId) await this.assertAgent(auth.tenantId, input.agentId);

    // The token must actually reach this number: nobody can claim a number they don't control
    let info;
    try {
      const ids = await this.graph.wabaPhoneNumberIds(token, wabaId);
      if (!ids.includes(phoneNumberId))
        throw new AppException(
          HttpStatus.BAD_REQUEST,
          "VALIDATION_FAILED",
          "This phone number isn't in that WhatsApp Business account.",
          [{ path: "phoneNumberId", message: "Not in this WhatsApp Business account" }],
        );
      info = await this.graph.phoneNumber(token, phoneNumberId);
      await this.graph.subscribeApp(token, wabaId);
    } catch (err) {
      if (err instanceof AppException) throw err;
      throw metaProblem(err, "Connecting to WhatsApp");
    }

    // Embedded Signup numbers are new to the Cloud API and must be registered (sets a two-step PIN).
    // Pasted tokens belong to numbers the business already runs: their PIN is left alone.
    let pin: string | null = null;
    let registerError: string | null = null;
    if (input.via === "embedded_signup") {
      pin = String(randomInt(0, 1_000_000)).padStart(6, "0");
      try {
        await this.graph.register(token, phoneNumberId, pin);
      } catch (err) {
        registerError = err instanceof WhatsAppError ? err.message : "Registration failed";
        this.logger.warn(
          { tenantId: auth.tenantId, err: registerError },
          "WhatsApp number registration failed",
        );
      }
    }

    const integrationId = randomUUID();
    const sealed = await this.keys.seal(auth.tenantId, purpose(integrationId), {
      kind: "cloud_api",
      accessToken: token,
      pin,
      via: input.via,
    } satisfies StoredCredentials);

    try {
      return await this.tenantDb.tx(auth.tenantId, async (tx) => {
        const existing = await tx.whatsAppNumber.findUnique({ where: { phoneNumberId } });
        if (existing?.integrationId) await tx.integration.delete({ where: { id: existing.integrationId } });
        await tx.integration.create({
          data: {
            id: integrationId,
            tenantId: auth.tenantId,
            type: "WHATSAPP",
            name: `WhatsApp ${info.displayPhoneNumber || phoneNumberId}`.slice(0, 80),
            credentialsEncrypted: sealed,
            config: { phoneNumberId, wabaId, via: input.via },
          },
        });
        const data = {
          integrationId,
          wabaId,
          displayNumber: info.displayPhoneNumber || phoneNumberId,
          verifiedName: info.verifiedName,
          qualityRating: info.qualityRating,
          status: registerError ? ("PENDING" as const) : ("CONNECTED" as const),
          lastError: registerError ? `Meta registration: ${registerError}` : null,
          connectedAt: new Date(),
          ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
        };
        const number = existing
          ? await tx.whatsAppNumber.update({ where: { id: existing.id }, data, select: NUMBER_VIEW })
          : await tx.whatsAppNumber.create({
              data: { tenantId: auth.tenantId, phoneNumberId, ...data },
              select: NUMBER_VIEW,
            });
        await this.audit.record(tx, auth, {
          action: "whatsapp.connected",
          entityType: "whatsapp_number",
          entityId: number.id,
          after: { displayNumber: number.displayNumber, wabaId, via: input.via, status: number.status },
          ...meta,
        });
        return number;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
        throw new AppException(
          HttpStatus.CONFLICT,
          "CONFLICT",
          "This WhatsApp number is already connected to another business on this platform.",
        );
      throw err;
    }
  }

  async update(auth: AuthContext, id: string, body: z.output<typeof UpdateWhatsAppNumberBody>, meta: Meta) {
    if (body.agentId) await this.assertAgent(auth.tenantId, body.agentId);
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const before = await tx.whatsAppNumber.findUnique({ where: { id } });
      if (!before || before.status === "DISCONNECTED") throw numberNotFound();
      const settings = body.settings
        ? WhatsAppNumberSettings.parse({ ...(before.settings as object), ...body.settings })
        : undefined;
      const number = await tx.whatsAppNumber.update({
        where: { id },
        data: {
          ...(body.agentId !== undefined ? { agentId: body.agentId } : {}),
          ...(settings ? { settings } : {}),
        },
        select: NUMBER_VIEW,
      });
      await this.audit.record(tx, auth, {
        action: "whatsapp.updated",
        entityType: "whatsapp_number",
        entityId: id,
        before: { agentId: before.agentId, settings: before.settings },
        after: { agentId: number.agent?.id ?? null, settings: number.settings },
        ...meta,
      });
      return number;
    });
  }

  /** Finish a registration that failed while connecting */
  async retryRegistration(auth: AuthContext, id: string) {
    const number = await this.find(auth.tenantId, id);
    const creds = await this.credentials(auth.tenantId, number);
    const pin = creds.pin ?? String(randomInt(0, 1_000_000)).padStart(6, "0");
    try {
      await this.graph.register(creds.accessToken, number.phoneNumberId, pin);
    } catch (err) {
      await this.tenantDb.db(auth.tenantId).whatsAppNumber.update({
        where: { id },
        data: { lastError: `Meta registration: ${err instanceof Error ? err.message : "failed"}` },
      });
      throw metaProblem(err, "Registering the number");
    }
    return this.tenantDb.db(auth.tenantId).whatsAppNumber.update({
      where: { id },
      data: { status: "CONNECTED", lastError: null },
      select: NUMBER_VIEW,
    });
  }

  /**
   * Meta's "hello_world" template (every account has it): works even without a recent message
   * from the recipient, so it proves sending end to end.
   */
  async sendTest(auth: AuthContext, id: string, to: string): Promise<{ ok: boolean; message: string }> {
    const number = await this.find(auth.tenantId, id);
    const creds = await this.credentials(auth.tenantId, number);
    try {
      await this.graph.sendTemplate(
        creds.accessToken,
        number.phoneNumberId,
        to.replace(/\D/g, ""),
        "hello_world",
        "en_US",
      );
      return { ok: true, message: `Test message sent to ${to}. It should arrive in a few seconds.` };
    } catch (err) {
      return { ok: false, message: err instanceof WhatsAppError ? err.message : "Sending failed" };
    }
  }

  async disconnect(auth: AuthContext, id: string, meta: Meta): Promise<void> {
    const number = await this.find(auth.tenantId, id);
    if (number.integrationId) {
      // Best effort: stop Meta sending this account's webhooks to the platform
      const creds = await this.credentials(auth.tenantId, number).catch(() => null);
      if (creds)
        await this.graph
          .unsubscribeApp(creds.accessToken, number.wabaId)
          .catch((err: unknown) => this.logger.warn({ err, id }, "could not unsubscribe the WhatsApp app"));
    }
    await this.tenantDb.tx(auth.tenantId, async (tx) => {
      // Conversations keep their history; the token is deleted with its integration
      if (number.integrationId) await tx.integration.delete({ where: { id: number.integrationId } });
      await tx.whatsAppNumber.update({
        where: { id },
        data: { status: "DISCONNECTED", integrationId: null, lastError: null },
      });
      await this.audit.record(tx, auth, {
        action: "whatsapp.disconnected",
        entityType: "whatsapp_number",
        entityId: id,
        before: { displayNumber: number.displayNumber },
        ...meta,
      });
    });
  }

  /** The business token for a number (used to send and download) */
  async credentials(
    tenantId: string,
    number: Pick<WhatsAppNumber, "id" | "integrationId">,
  ): Promise<StoredCredentials> {
    if (!number.integrationId)
      throw new AppException(HttpStatus.CONFLICT, "CONFLICT", "This WhatsApp number is disconnected");
    const integration = await this.tenantDb
      .db(tenantId)
      .integration.findUnique({ where: { id: number.integrationId } });
    if (!integration)
      throw new AppException(HttpStatus.CONFLICT, "CONFLICT", "This WhatsApp number is disconnected");
    return this.keys.open<StoredCredentials>(
      tenantId,
      purpose(integration.id),
      integration.credentialsEncrypted,
    );
  }

  /** Meta rejected the token: show it on the settings page so the owner reconnects */
  async markTokenProblem(tenantId: string, numberId: string, message: string): Promise<void> {
    await this.tenantDb
      .db(tenantId)
      .whatsAppNumber.update({ where: { id: numberId }, data: { lastError: message.slice(0, 500) } })
      .catch(() => undefined);
  }

  private async find(tenantId: string, id: string): Promise<WhatsAppNumber> {
    const n = await this.tenantDb.db(tenantId).whatsAppNumber.findUnique({ where: { id } });
    if (!n || n.status === "DISCONNECTED") throw numberNotFound();
    return n;
  }

  private async assertAgent(tenantId: string, agentId: string): Promise<void> {
    const agent = await this.tenantDb.db(tenantId).agent.findUnique({ where: { id: agentId } });
    if (!agent)
      throw new AppException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Unknown agent", [
        { path: "agentId", message: "Unknown agent" },
      ]);
  }
}

const numberNotFound = () => new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "WhatsApp number not found");
