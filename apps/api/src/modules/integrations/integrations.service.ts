import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { randomToken } from "@platform/crypto";
import type { Integration, Prisma, TenantTx } from "@platform/db";
import {
  CONNECTABLE_INTEGRATIONS,
  type ConnectableIntegration,
  type CreateIntegrationBody,
  INTEGRATION_CONFIG,
  INTEGRATION_CREDENTIALS,
  TOOL_SPECS,
  type ToolName,
  type UpdateIntegrationBody,
  zodIssuesToFieldErrors,
} from "@platform/shared";
import { testConnection, ToolError, type ToolBinding } from "@platform/tools";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { AppException } from "../../common/filters/problem-details.filter";
import { API_ENV, type ApiEnv } from "../../config/env";
import { TenantDbService } from "../../infra/tenant-db.service";
import { TenantKeysService } from "../../infra/tenant-keys.service";
import { AuditService } from "../audit/audit.service";

type Meta = { ip?: string; userAgent?: string };
type Actor = AuthContext | { kind: "system"; tenantId: string };

/** Columns that may leave the server. Credentials never do. */
export const INTEGRATION_VIEW = {
  id: true,
  type: true,
  name: true,
  status: true,
  config: true,
  lastError: true,
  lastCheckedAt: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const purpose = (id: string) => `integration:${id}`;

/** Normalise validated credential input into what is stored */
function storedCredentials(
  type: ConnectableIntegration,
  input: Record<string, unknown>,
): {
  credentials: Record<string, unknown>;
  publicConfig: Record<string, unknown>;
  revealOnce?: Record<string, string>;
} {
  switch (type) {
    case "GOOGLE_CALENDAR":
    case "GOOGLE_SHEETS": {
      const sa = (input as { json: { clientEmail: string; privateKey: string } }).json;
      // The service account's address is not secret: staff share the calendar/sheet with it
      return {
        credentials: { kind: "service_account", clientEmail: sa.clientEmail, privateKey: sa.privateKey },
        publicConfig: { account: sa.clientEmail },
      };
    }
    case "WEBHOOK": {
      const secret = (input.secret as string | undefined) ?? `whsec_${randomToken(24)}`;
      return {
        credentials: { secret },
        publicConfig: {},
        ...(input.secret ? {} : { revealOnce: { signingSecret: secret } }),
      };
    }
    case "EMAIL_SMTP":
      return { credentials: input, publicConfig: { host: input.host, port: input.port } };
  }
}

const isConnectable = (t: string): t is ConnectableIntegration =>
  (CONNECTABLE_INTEGRATIONS as readonly string[]).includes(t);

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new AppException(
      HttpStatus.BAD_REQUEST,
      "VALIDATION_FAILED",
      "Invalid integration settings",
      zodIssuesToFieldErrors(r.error.issues).map((e) => ({
        ...e,
        path: e.path ? `${path}.${e.path}` : path,
      })),
    );
  }
  return r.data;
}

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly tenantDb: TenantDbService,
    private readonly keys: TenantKeysService,
    private readonly audit: AuditService,
  ) {}

  get googleOAuth() {
    return this.env.GOOGLE_OAUTH_CLIENT_ID && this.env.GOOGLE_OAUTH_CLIENT_SECRET
      ? { clientId: this.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: this.env.GOOGLE_OAUTH_CLIENT_SECRET }
      : undefined;
  }

  get toolNetwork() {
    return {
      allowPrivateNetwork: this.env.ALLOW_PRIVATE_NETWORK_TOOLS,
      ...(this.googleOAuth ? { googleOAuth: this.googleOAuth } : {}),
    };
  }

  async list(tenantId: string) {
    const rows = await this.tenantDb.db(tenantId).integration.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        ...INTEGRATION_VIEW,
        agentTools: { select: { toolName: true, agent: { select: { id: true, name: true } } } },
      },
    });
    return rows.map(({ agentTools, ...i }) => ({
      ...i,
      usedBy: agentTools.map((t) => ({ tool: t.toolName, agent: t.agent })),
    }));
  }

  /** Create from validated input (API form) or from an OAuth grant (already-normalised credentials) */
  async create(
    actor: Actor,
    input:
      | CreateIntegrationBody
      | {
          type: "GOOGLE_CALENDAR" | "GOOGLE_SHEETS";
          name: string;
          config: Record<string, unknown>;
          stored: Record<string, unknown>;
        },
    meta: Meta,
  ) {
    const id = randomUUID();
    const normalised =
      "stored" in input
        ? { credentials: input.stored, publicConfig: {} as Record<string, unknown>, revealOnce: undefined }
        : storedCredentials(input.type, input.credentials as Record<string, unknown>);
    const sealed = await this.keys.seal(actor.tenantId, purpose(id), normalised.credentials);
    const created = await this.tenantDb.tx(actor.tenantId, async (tx) => {
      await this.assertNameFree(tx, input.name);
      const row = await tx.integration.create({
        data: {
          id,
          tenantId: actor.tenantId,
          type: input.type,
          name: input.name,
          status: "CONNECTED",
          credentialsEncrypted: sealed,
          config: { ...(input.config as object), ...normalised.publicConfig } as Prisma.InputJsonObject,
        },
        select: INTEGRATION_VIEW,
      });
      await this.audit.record(tx, actor, {
        action: "integration.created",
        entityType: "integration",
        entityId: id,
        after: { type: input.type, name: input.name, config: row.config },
        ...meta,
      });
      return row;
    });
    return { ...created, ...(normalised.revealOnce ?? {}) };
  }

  async update(auth: AuthContext, id: string, body: z.output<typeof UpdateIntegrationBody>, meta: Meta) {
    const existing = await this.find(auth.tenantId, id);
    if (!isConnectable(existing.type))
      throw new AppException(HttpStatus.CONFLICT, "CONFLICT", "This integration type can't be edited yet");
    const type = existing.type;
    const config = body.config
      ? (parseOrThrow(INTEGRATION_CONFIG[type], body.config, "config") as Record<string, unknown>)
      : undefined;
    let credentials: Uint8Array<ArrayBuffer> | undefined;
    let publicConfig: Record<string, unknown> = {};
    let revealOnce: Record<string, string> | undefined;
    if (body.credentials) {
      const parsed = parseOrThrow(INTEGRATION_CREDENTIALS[type], body.credentials, "credentials") as Record<
        string,
        unknown
      >;
      const n = storedCredentials(type, parsed);
      credentials = await this.keys.seal(auth.tenantId, purpose(id), n.credentials);
      publicConfig = n.publicConfig;
      revealOnce = n.revealOnce;
    }
    const row = await this.tenantDb.tx(auth.tenantId, async (tx) => {
      if (body.name && body.name !== existing.name) await this.assertNameFree(tx, body.name);
      const updated = await tx.integration.update({
        where: { id },
        data: {
          ...(body.name ? { name: body.name } : {}),
          ...(config || body.credentials
            ? {
                config: {
                  ...(existing.config as object),
                  ...(config ?? {}),
                  ...publicConfig,
                } as Prisma.InputJsonObject,
              }
            : {}),
          ...(credentials
            ? { credentialsEncrypted: credentials, status: "CONNECTED" as const, lastError: null }
            : {}),
        },
        select: INTEGRATION_VIEW,
      });
      await this.audit.record(tx, auth, {
        action: "integration.updated",
        entityType: "integration",
        entityId: id,
        after: { name: body.name, config, credentialsChanged: Boolean(body.credentials) },
        ...meta,
      });
      return updated;
    });
    return { ...row, ...(revealOnce ?? {}) };
  }

  async remove(auth: AuthContext, id: string, meta: Meta): Promise<void> {
    await this.tenantDb.tx(auth.tenantId, async (tx) => {
      const existing = await tx.integration.findUnique({ where: { id } });
      if (!existing) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Integration not found");
      await tx.integration.delete({ where: { id } }); // tool bindings cascade; appointments keep their data
      await this.audit.record(tx, auth, {
        action: "integration.deleted",
        entityType: "integration",
        entityId: id,
        before: { type: existing.type, name: existing.name },
        ...meta,
      });
    });
  }

  /** Try the connection for real and record the outcome */
  async test(auth: AuthContext, id: string): Promise<{ ok: boolean; message: string }> {
    const existing = await this.find(auth.tenantId, id);
    const credentials = await this.keys.open<Record<string, unknown>>(
      auth.tenantId,
      purpose(id),
      existing.credentialsEncrypted,
    );
    let result: { ok: boolean; message: string };
    try {
      result = {
        ok: true,
        message: await testConnection(
          existing.type,
          existing.config as Record<string, unknown>,
          credentials,
          this.toolNetwork,
        ),
      };
    } catch (err) {
      result = { ok: false, message: err instanceof ToolError ? err.message : "The connection test failed" };
    }
    await this.tenantDb.db(auth.tenantId).integration.update({
      where: { id },
      data: {
        status: result.ok ? "CONNECTED" : "ERROR",
        lastError: result.ok ? null : result.message.slice(0, 500),
        lastCheckedAt: new Date(),
      },
    });
    return result;
  }

  /** The integration an agent uses for a tool, decrypted for one execution */
  async bindingFor(tenantId: string, agentId: string, tool: ToolName): Promise<ToolBinding | null> {
    const spec = TOOL_SPECS[tool];
    if (!spec.integration) return null;
    const grant = await this.tenantDb.db(tenantId).agentTool.findUnique({
      where: { agentId_toolName: { agentId, toolName: tool } },
      include: { integration: true },
    });
    const integration = grant?.enabled ? grant.integration : null;
    if (!integration || integration.type !== spec.integration || integration.status === "DISCONNECTED")
      return null;
    return this.decrypt(tenantId, integration);
  }

  /** First connected integration of a type (staff notifications) */
  async firstOfType(tenantId: string, type: ConnectableIntegration): Promise<ToolBinding | null> {
    const integration = await this.tenantDb.db(tenantId).integration.findFirst({
      where: { type, status: { in: ["CONNECTED", "ERROR"] } },
      orderBy: { createdAt: "asc" },
    });
    return integration ? this.decrypt(tenantId, integration) : null;
  }

  async byId(tenantId: string, id: string): Promise<ToolBinding | null> {
    const integration = await this.tenantDb.db(tenantId).integration.findUnique({ where: { id } });
    return integration ? this.decrypt(tenantId, integration) : null;
  }

  /** A tool hit rejected credentials or settings: show it on the integrations page */
  async markError(tenantId: string, id: string, message: string): Promise<void> {
    await this.tenantDb
      .db(tenantId)
      .integration.update({
        where: { id },
        data: { status: "ERROR", lastError: message.slice(0, 500), lastCheckedAt: new Date() },
      })
      .catch((err: unknown) => this.logger.warn({ err, id }, "could not mark integration error"));
  }

  private async decrypt(tenantId: string, i: Integration): Promise<ToolBinding> {
    return {
      integrationId: i.id,
      type: i.type,
      config: (i.config ?? {}) as Record<string, unknown>,
      credentials: await this.keys.open<Record<string, unknown>>(
        tenantId,
        purpose(i.id),
        i.credentialsEncrypted,
      ),
    };
  }

  private async find(tenantId: string, id: string): Promise<Integration> {
    const row = await this.tenantDb.db(tenantId).integration.findUnique({ where: { id } });
    if (!row) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Integration not found");
    return row;
  }

  private async assertNameFree(tx: TenantTx, name: string): Promise<void> {
    if (await tx.integration.count({ where: { name } }))
      throw new AppException(
        HttpStatus.CONFLICT,
        "CONFLICT",
        "An integration with this name already exists",
        [{ path: "name", message: "Name already used" }],
      );
  }
}
