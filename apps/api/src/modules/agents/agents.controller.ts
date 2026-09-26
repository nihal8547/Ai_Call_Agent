import { Body, Controller, Get, HttpStatus, Param, Patch, Post, Put, Req } from "@nestjs/common";
import { sha256Hex } from "@platform/crypto";
import { type AgentVersion, readJson, type TenantTx } from "@platform/db";
import {
  AgentConfig,
  CreateAgentBody,
  IdParam,
  SaveToolBindingsBody,
  SaveDraftBody,
  SetAgentStatusBody,
  TOOL_SPECS,
  UpdateAgentBody,
  zodIssuesToFieldErrors,
} from "@platform/shared";
import { getTemplate, instantiateTemplate, TEMPLATES } from "@platform/templates";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, RequirePermissions } from "../../common/auth/decorators";
import { AppException } from "../../common/filters/problem-details.filter";
import { requestMeta } from "../../common/http/request-meta";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AuditService } from "../audit/audit.service";

const VersionParams = z.object({ id: z.uuid(), versionId: z.uuid() });

const versionView = (v: AgentVersion | null | undefined) =>
  v
    ? {
        id: v.id,
        version: v.version,
        status: v.status,
        config: v.config,
        changeNote: v.changeNote,
        publishedAt: v.publishedAt,
        createdAt: v.createdAt,
      }
    : null;

/** Parse a config and report problems as `config.<path>` field errors */
function parseConfig(raw: unknown): AgentConfig {
  const r = AgentConfig.safeParse(raw);
  if (!r.success) {
    throw new AppException(
      HttpStatus.BAD_REQUEST,
      "VALIDATION_FAILED",
      "The agent configuration has problems",
      zodIssuesToFieldErrors(r.error.issues).map((e) => ({
        ...e,
        path: e.path ? `config.${e.path}` : "config",
      })),
    );
  }
  return r.data;
}

const INTEGRATION_LABEL: Record<string, string> = {
  GOOGLE_CALENDAR: "Google Calendar",
  GOOGLE_SHEETS: "Google Sheets",
  EMAIL_SMTP: "an email account",
  WEBHOOK: "a webhook",
};

/**
 * Only publish configs whose tools can actually run: implemented, and bound to a connected
 * integration of the right kind. Drafts may reference anything.
 */
async function assertToolsReady(tx: TenantTx, agentId: string, config: AgentConfig): Promise<void> {
  const grants = await tx.agentTool.findMany({
    where: { agentId, enabled: true },
    include: { integration: { select: { type: true, status: true, name: true } } },
  });
  const errors = config.tools.flatMap((tool, i) => {
    const spec = TOOL_SPECS[tool];
    const path = `config.tools.${i}`;
    if (!spec.available) return [{ path, message: `"${spec.label}" is not available yet` }];
    if (!spec.integration) return [];
    const integration = grants.find((g) => g.toolName === tool)?.integration;
    if (!integration || integration.type !== spec.integration)
      return [
        {
          path,
          message: `Connect ${INTEGRATION_LABEL[spec.integration] ?? spec.integration} and choose it for "${spec.label}"`,
        },
      ];
    if (integration.status === "DISCONNECTED")
      return [{ path, message: `"${integration.name}" is disconnected` }];
    return [];
  });
  if (errors.length)
    throw new AppException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Some tools cannot run yet", errors);
}

@Controller()
export class AgentsController {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
  ) {}

  @RequirePermissions("agents:read")
  @Get("agent-templates")
  templates() {
    return {
      items: TEMPLATES.map(({ key, name, industry, description }) => ({ key, name, industry, description })),
    };
  }

  @RequirePermissions("agents:read")
  @Get("agents")
  async list(@CurrentAuth() auth: AuthContext) {
    const agents = await this.tenantDb.db(auth.tenantId).agent.findMany({
      where: { status: { not: "ARCHIVED" } },
      orderBy: { createdAt: "asc" },
      include: {
        publishedVersion: { select: { version: true, publishedAt: true } },
        phoneNumbers: { select: { e164: true } },
        versions: { where: { status: "DRAFT" }, select: { id: true }, take: 1 },
        _count: { select: { calls: true } },
      },
    });
    return {
      items: agents.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        status: a.status,
        templateKey: a.templateKey,
        publishedVersion: a.publishedVersion,
        hasDraft: a.versions.length > 0,
        phoneNumbers: a.phoneNumbers.map((p) => p.e164),
        calls: a._count.calls,
        createdAt: a.createdAt,
      })),
    };
  }

  /** New agents start as a draft built from a template */
  @RequirePermissions("agents:write")
  @Post("agents")
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(CreateAgentBody)) body: z.output<typeof CreateAgentBody>,
    @Req() req: FastifyRequest,
  ) {
    if (!getTemplate(body.templateKey)) {
      throw new AppException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Unknown template", [
        { path: "templateKey", message: "Unknown template" },
      ]);
    }
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId } });
      const config = instantiateTemplate(body.templateKey, {
        businessName: tenant.name,
        ...(body.agentName ? { agentName: body.agentName } : {}),
      });
      const agent = await tx.agent.create({
        data: {
          tenantId: auth.tenantId,
          name: body.name,
          description: body.description ?? null,
          templateKey: body.templateKey,
        },
      });
      await tx.agentVersion.create({
        data: {
          tenantId: auth.tenantId,
          agentId: agent.id,
          version: 1,
          config,
          configHash: sha256Hex(JSON.stringify(config)),
          changeNote: `Created from template ${body.templateKey}`,
          createdById: auth.kind === "user" ? auth.userId : null,
        },
      });
      await this.audit.record(tx, auth, {
        action: "agent.created",
        entityType: "agent",
        entityId: agent.id,
        after: body,
        ...requestMeta(req),
      });
      return { id: agent.id };
    });
  }

  @RequirePermissions("agents:read")
  @Get("agents/:id")
  async get(@CurrentAuth() auth: AuthContext, @Param(new ZodValidationPipe(IdParam)) { id }: { id: string }) {
    const db = this.tenantDb.db(auth.tenantId);
    const agent = await db.agent.findUnique({
      where: { id },
      include: { publishedVersion: true, phoneNumbers: { select: { id: true, e164: true } } },
    });
    if (!agent || agent.status === "ARCHIVED")
      throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Agent not found");
    const draft = await db.agentVersion.findFirst({
      where: { agentId: id, status: "DRAFT" },
      orderBy: { version: "desc" },
    });
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      status: agent.status,
      templateKey: agent.templateKey,
      phoneNumbers: agent.phoneNumbers,
      published: versionView(agent.publishedVersion),
      draft: versionView(draft),
    };
  }

  @RequirePermissions("agents:write")
  @Patch("agents/:id")
  update(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Body(new ZodValidationPipe(UpdateAgentBody)) body: z.output<typeof UpdateAgentBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      await this.findAgent(tx, id);
      const agent = await tx.agent.update({
        where: { id },
        data: body,
        select: { id: true, name: true, description: true },
      });
      await this.audit.record(tx, auth, {
        action: "agent.updated",
        entityType: "agent",
        entityId: id,
        after: body,
        ...requestMeta(req),
      });
      return agent;
    });
  }

  /** Save the working copy. Published versions are never edited; calls keep using them until publish. */
  @RequirePermissions("agents:write")
  @Put("agents/:id/draft")
  saveDraft(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Body(new ZodValidationPipe(SaveDraftBody)) body: z.output<typeof SaveDraftBody>,
    @Req() req: FastifyRequest,
  ) {
    const config = parseConfig(body.config);
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      await this.findAgent(tx, id);
      const data = {
        config,
        configHash: sha256Hex(JSON.stringify(config)),
        changeNote: body.changeNote ?? null,
      };
      const draft = await tx.agentVersion.findFirst({
        where: { agentId: id, status: "DRAFT" },
        orderBy: { version: "desc" },
      });
      const saved = draft
        ? await tx.agentVersion.update({ where: { id: draft.id }, data })
        : await tx.agentVersion.create({
            data: {
              tenantId: auth.tenantId,
              agentId: id,
              version:
                ((await tx.agentVersion.aggregate({ where: { agentId: id }, _max: { version: true } }))._max
                  .version ?? 0) + 1,
              createdById: auth.kind === "user" ? auth.userId : null,
              ...data,
            },
          });
      await this.audit.record(tx, auth, {
        action: "agent.draft_saved",
        entityType: "agent",
        entityId: id,
        after: { version: saved.version },
        ...requestMeta(req),
      });
      return versionView(saved);
    });
  }

  /** Make the draft live. New calls use it immediately; calls in progress finish on their version. */
  @RequirePermissions("agents:publish")
  @Post("agents/:id/publish")
  publish(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Req() req: FastifyRequest,
  ) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const agent = await this.findAgent(tx, id);
      const draft = await tx.agentVersion.findFirst({
        where: { agentId: id, status: "DRAFT" },
        orderBy: { version: "desc" },
      });
      if (!draft) throw new AppException(HttpStatus.CONFLICT, "CONFLICT", "There is no draft to publish");
      const config = parseConfig(readJson(AgentConfig, draft.config, "agent_versions.config"));
      await assertToolsReady(tx, id, config);
      const known = new Set(
        (
          await tx.knowledgeCollection.findMany({
            where: { id: { in: config.knowledge.collectionIds } },
            select: { id: true },
          })
        ).map((c) => c.id),
      );
      const missing = config.knowledge.collectionIds
        .map((cid, i) => ({ cid, i }))
        .filter(({ cid }) => !known.has(cid));
      if (missing.length) {
        throw new AppException(
          HttpStatus.BAD_REQUEST,
          "VALIDATION_FAILED",
          "Unknown knowledge collections",
          missing.map(({ i }) => ({
            path: `config.knowledge.collectionIds.${i}`,
            message: "This collection no longer exists",
          })),
        );
      }

      await tx.agentVersion.updateMany({
        where: { agentId: id, status: "PUBLISHED" },
        data: { status: "RETIRED" },
      });
      const published = await tx.agentVersion.update({
        where: { id: draft.id },
        data: { status: "PUBLISHED", publishedAt: new Date() },
      });
      await tx.agent.update({
        where: { id },
        data: { publishedVersionId: published.id, ...(agent.publishedVersionId ? {} : { status: "ACTIVE" }) },
      });
      await this.audit.record(tx, auth, {
        action: "agent.published",
        entityType: "agent",
        entityId: id,
        before: { version: agent.publishedVersionId },
        after: { version: published.version },
        ...requestMeta(req),
      });
      return versionView(published);
    });
  }

  @RequirePermissions("agents:write")
  @Post("agents/:id/status")
  setStatus(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Body(new ZodValidationPipe(SetAgentStatusBody)) body: z.output<typeof SetAgentStatusBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const agent = await this.findAgent(tx, id);
      if (body.status === "ACTIVE" && !agent.publishedVersionId) {
        throw new AppException(HttpStatus.CONFLICT, "CONFLICT", "Publish the agent before activating it");
      }
      const updated = await tx.agent.update({
        where: { id },
        data: { status: body.status },
        select: { id: true, status: true },
      });
      await this.audit.record(tx, auth, {
        action: `agent.${body.status.toLowerCase()}`,
        entityType: "agent",
        entityId: id,
        ...requestMeta(req),
      });
      return updated;
    });
  }

  /** Which integration each tool uses for this agent (applies immediately, like phone numbers) */
  @RequirePermissions("agents:read")
  @Get("agents/:id/tool-bindings")
  async toolBindings(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
  ) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      await this.findAgent(tx, id);
      const rows = await tx.agentTool.findMany({
        where: { agentId: id },
        include: { integration: { select: { id: true, name: true, type: true, status: true } } },
        orderBy: { toolName: "asc" },
      });
      return {
        items: rows.map((r) => ({ toolName: r.toolName, enabled: r.enabled, integration: r.integration })),
      };
    });
  }

  @RequirePermissions("agents:write")
  @Put("agents/:id/tool-bindings")
  saveToolBindings(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Body(new ZodValidationPipe(SaveToolBindingsBody)) body: z.output<typeof SaveToolBindingsBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      await this.findAgent(tx, id);
      const ids = body.bindings.map((b) => b.integrationId).filter((x): x is string => Boolean(x));
      const integrations = new Map(
        (await tx.integration.findMany({ where: { id: { in: ids } } })).map((i) => [i.id, i]),
      );
      const errors = body.bindings.flatMap((b, i) => {
        if (!b.integrationId) return [];
        const integration = integrations.get(b.integrationId);
        const wanted = TOOL_SPECS[b.toolName].integration;
        if (!integration) return [{ path: `bindings.${i}.integrationId`, message: "Unknown integration" }];
        if (!wanted || integration.type !== wanted)
          return [
            {
              path: `bindings.${i}.integrationId`,
              message: `"${integration.name}" can't run ${TOOL_SPECS[b.toolName].label}`,
            },
          ];
        return [];
      });
      if (errors.length)
        throw new AppException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Invalid tool bindings", errors);
      for (const b of body.bindings) {
        if (b.integrationId) {
          await tx.agentTool.upsert({
            where: { agentId_toolName: { agentId: id, toolName: b.toolName } },
            create: {
              tenantId: auth.tenantId,
              agentId: id,
              toolName: b.toolName,
              integrationId: b.integrationId,
            },
            update: { integrationId: b.integrationId, enabled: true },
          });
        } else {
          await tx.agentTool.deleteMany({ where: { agentId: id, toolName: b.toolName } });
        }
      }
      await this.audit.record(tx, auth, {
        action: "agent.tool_bindings_updated",
        entityType: "agent",
        entityId: id,
        after: body,
        ...requestMeta(req),
      });
      const rows = await tx.agentTool.findMany({
        where: { agentId: id },
        include: { integration: { select: { id: true, name: true, type: true, status: true } } },
        orderBy: { toolName: "asc" },
      });
      return {
        items: rows.map((r) => ({ toolName: r.toolName, enabled: r.enabled, integration: r.integration })),
      };
    });
  }

  @RequirePermissions("agents:read")
  @Get("agents/:id/versions")
  async versions(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
  ) {
    const items = await this.tenantDb.db(auth.tenantId).agentVersion.findMany({
      where: { agentId: id },
      orderBy: { version: "desc" },
      select: {
        id: true,
        version: true,
        status: true,
        changeNote: true,
        createdAt: true,
        publishedAt: true,
        configHash: true,
      },
    });
    return { items };
  }

  @RequirePermissions("agents:read")
  @Get("agents/:id/versions/:versionId")
  async version(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(VersionParams)) p: z.output<typeof VersionParams>,
  ) {
    const v = await this.tenantDb
      .db(auth.tenantId)
      .agentVersion.findFirst({ where: { id: p.versionId, agentId: p.id } });
    if (!v) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Version not found");
    return versionView(v);
  }

  /** Copy an earlier version into the draft (publish it to roll back) */
  @RequirePermissions("agents:write")
  @Post("agents/:id/versions/:versionId/restore")
  restore(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(VersionParams)) p: z.output<typeof VersionParams>,
    @Req() req: FastifyRequest,
  ) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      await this.findAgent(tx, p.id);
      const source = await tx.agentVersion.findFirst({ where: { id: p.versionId, agentId: p.id } });
      if (!source) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Version not found");
      const config = parseConfig(source.config);
      const data = {
        config,
        configHash: sha256Hex(JSON.stringify(config)),
        changeNote: `Restored from version ${source.version}`,
      };
      const draft = await tx.agentVersion.findFirst({
        where: { agentId: p.id, status: "DRAFT" },
        orderBy: { version: "desc" },
      });
      const saved = draft
        ? await tx.agentVersion.update({ where: { id: draft.id }, data })
        : await tx.agentVersion.create({
            data: {
              tenantId: auth.tenantId,
              agentId: p.id,
              version:
                ((await tx.agentVersion.aggregate({ where: { agentId: p.id }, _max: { version: true } }))._max
                  .version ?? 0) + 1,
              createdById: auth.kind === "user" ? auth.userId : null,
              ...data,
            },
          });
      await this.audit.record(tx, auth, {
        action: "agent.version_restored",
        entityType: "agent",
        entityId: p.id,
        after: { from: source.version, draft: saved.version },
        ...requestMeta(req),
      });
      return versionView(saved);
    });
  }

  private async findAgent(tx: TenantTx, id: string) {
    const agent = await tx.agent.findUnique({ where: { id } });
    if (!agent || agent.status === "ARCHIVED")
      throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Agent not found");
    return agent;
  }
}
