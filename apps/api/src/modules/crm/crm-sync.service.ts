import { HttpStatus, Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { Prisma } from "@platform/db";
import {
  AgentConfig,
  CRM_INTEGRATIONS,
  CrmConfig,
  type CrmIntegration,
  type LeadSyncJob,
  type QueueJob,
  type SaveCrmMappingBody,
} from "@platform/shared";
import {
  BUILTIN_CRM_SOURCES,
  buildCrmRecord,
  type CrmCredentials,
  type CrmDeps,
  type CrmProperty,
  hubspotProperties,
  hubspotUpsertContact,
  type MappableSource,
  ToolError,
  validateCrmMapping,
  zohoFields,
  zohoUpsertLead,
} from "@platform/tools";
import { type Job, UnrecoverableError } from "bullmq";
import { randomUUID } from "node:crypto";
import type { AuthContext } from "../../common/auth/auth.types";
import { AppException } from "../../common/filters/problem-details.filter";
import { API_ENV, type ApiEnv } from "../../config/env";
import { QueueService } from "../../infra/queue.service";
import { RedisService } from "../../infra/redis.service";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AuditService } from "../audit/audit.service";
import { IntegrationsService } from "../integrations/integrations.service";
import { JobProcessors } from "../jobs/job-processors.service";

/** Per CRM integration, on each lead */
export type CrmSyncState = {
  status: "pending" | "synced" | "failed";
  externalId: string | null;
  syncedAt: string | null;
  error: string | null;
  /** Answers that could not be written (e.g. a choice with no matching CRM option) */
  skipped?: string[];
};

type Meta = { ip?: string; userAgent?: string };
const PROPS_TTL_SECONDS = 600;
const isCrm = (t: string): t is CrmIntegration => (CRM_INTEGRATIONS as readonly string[]).includes(t);

/**
 * Leads go to the business's CRM (HubSpot contacts, Zoho leads) through the `crm` queue: after
 * each call, when staff edit a lead, or on demand. Each lead remembers its CRM id and sync state.
 */
@Injectable()
export class CrmSyncService implements OnModuleInit {
  private readonly logger = new Logger(CrmSyncService.name);

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly tenantDb: TenantDbService,
    private readonly integrations: IntegrationsService,
    private readonly queues: QueueService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly processors: JobProcessors,
  ) {}

  onModuleInit(): void {
    this.processors.register("lead_sync", (job: Job<QueueJob>) => this.sync(job as Job<LeadSyncJob>));
  }

  private deps(type: CrmIntegration): CrmDeps {
    const oauthClient = type === "HUBSPOT" ? this.integrations.hubspotOAuth : this.integrations.zohoOAuth;
    return { fetch, timeoutMs: 10_000, ...(oauthClient ? { oauthClient } : {}) };
  }

  /**
   * Queue a lead for every connected CRM that syncs leads. Changes within a short window become one
   * sync (the job reads the lead as it is when it runs); `force` always queues. Never throws: a call
   * must still end cleanly.
   */
  async enqueueLead(tenantId: string, leadId: string, force = false): Promise<void> {
    try {
      const crms = await this.tenantDb.db(tenantId).integration.findMany({
        where: { type: { in: [...CRM_INTEGRATIONS] }, status: "CONNECTED" },
        select: { id: true, name: true, config: true },
      });
      const lead = await this.tenantDb
        .db(tenantId)
        .lead.findUnique({ where: { id: leadId }, select: { customerName: true, phone: true } });
      if (!lead) return;
      const delay = Math.max(1, Math.round(2000 * this.env.QUEUE_BACKOFF_SCALE));
      for (const crm of crms) {
        if (CrmConfig.safeParse(crm.config).data?.syncLeads === false) continue;
        const window = await this.redis.client.set(`crmsync:${leadId}:${crm.id}`, "1", "PX", delay, "NX");
        if (!window && !force) continue; // a sync that will read this change is already waiting
        await this.setState(tenantId, leadId, crm.id, { status: "pending" });
        await this.queues.add(
          "crm",
          {
            kind: "lead_sync",
            tenantId,
            leadId,
            integrationId: crm.id,
            label: `Send lead ${lead.customerName ?? lead.phone ?? ""} to ${crm.name}`.replace(/\s+/g, " "),
          },
          `lead-${leadId}-${crm.id}-${randomUUID()}`,
          delay,
        );
      }
    } catch (err) {
      this.logger.error({ err, leadId }, "could not queue the CRM sync");
    }
  }

  /** The `lead_sync` job */
  async sync(job: Job<LeadSyncJob>): Promise<unknown> {
    const d = job.data;
    const integration = await this.integrations.byId(d.tenantId, d.integrationId);
    if (!integration || !isCrm(integration.type))
      throw new UnrecoverableError("The CRM integration was removed");
    const lead = await this.tenantDb.db(d.tenantId).lead.findUnique({
      where: { id: d.leadId },
      include: {
        status: { select: { label: true } },
        agent: { select: { name: true } },
        call: { select: { summary: true, startedAt: true } },
      },
    });
    if (!lead) return { skipped: "lead deleted" };
    const config = CrmConfig.safeParse(integration.config).data ?? { syncLeads: true, mapping: {} };
    const previous = (lead.crmSync as Record<string, CrmSyncState>)[d.integrationId];
    const creds = integration.credentials as unknown as CrmCredentials;
    const deps = this.deps(integration.type);
    try {
      const properties = Object.keys(config.mapping).length
        ? await this.fetchProperties(d.integrationId, integration.type, creds)
        : [];
      const { record, skipped } = buildCrmRecord(
        {
          customerName: lead.customerName,
          phone: lead.phone,
          email: lead.email,
          data: lead.data as Record<string, unknown>,
          summary: lead.call?.summary ?? null,
          status: lead.status.label,
          agent: lead.agent?.name ?? null,
          callDate: lead.call?.startedAt ?? lead.createdAt,
        },
        config.mapping,
        properties,
      );
      const known = previous?.externalId ?? null;
      const externalId =
        integration.type === "HUBSPOT"
          ? await hubspotUpsertContact(creds, deps, record, known)
          : await zohoUpsertLead(creds, deps, record, known);
      await this.setState(d.tenantId, d.leadId, d.integrationId, {
        status: "synced",
        externalId,
        syncedAt: new Date().toISOString(),
        error: null,
        skipped,
      });
      return { externalId, skipped };
    } catch (err) {
      const e = err instanceof ToolError ? err : new ToolError("unavailable", (err as Error).message);
      if (e.kind === "auth" || e.kind === "config")
        await this.integrations.markError(d.tenantId, d.integrationId, e.message);
      const last = !e.retryable || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (last)
        await this.setState(d.tenantId, d.leadId, d.integrationId, { status: "failed", error: e.message });
      if (e.retryable) throw e;
      throw new UnrecoverableError(e.message);
    }
  }

  /** Merge one integration's state into the lead atomically (other CRMs may sync the same lead) */
  private async setState(
    tenantId: string,
    leadId: string,
    integrationId: string,
    patch: Partial<CrmSyncState>,
  ): Promise<void> {
    await this.tenantDb.tx(
      tenantId,
      (tx) =>
        tx.$executeRaw`
        UPDATE leads
        SET crm_sync = crm_sync || jsonb_build_object(
              ${integrationId}::text,
              coalesce(crm_sync -> ${integrationId}::text, '{"externalId":null,"syncedAt":null,"error":null}'::jsonb)
                || ${JSON.stringify(patch)}::jsonb),
            synced_to_crm = synced_to_crm OR ${patch.status === "synced"}
        WHERE id = ${leadId}::uuid`,
    );
  }

  private async fetchProperties(
    integrationId: string,
    type: CrmIntegration,
    creds: CrmCredentials,
    refresh = false,
  ): Promise<CrmProperty[]> {
    const key = `crmprops:${integrationId}`;
    if (!refresh) {
      const hit = await this.redis.client.get(key);
      if (hit) return JSON.parse(hit) as CrmProperty[];
    }
    const deps = this.deps(type);
    const props = type === "HUBSPOT" ? await hubspotProperties(creds, deps) : await zohoFields(creds, deps);
    await this.redis.client.set(key, JSON.stringify(props), "EX", PROPS_TTL_SECONDS);
    return props;
  }

  /** Every answer any agent collects (published or draft), plus built-in lead details */
  private async sources(tenantId: string): Promise<(MappableSource & { agents: string[] })[]> {
    const agents = await this.tenantDb.db(tenantId).agent.findMany({
      select: {
        name: true,
        publishedVersion: { select: { config: true } },
        versions: { where: { status: "DRAFT" }, select: { config: true }, take: 1 },
      },
      orderBy: { createdAt: "asc" },
    });
    const byKey = new Map<string, MappableSource & { agents: string[] }>();
    for (const a of agents) {
      for (const raw of [a.publishedVersion?.config, a.versions[0]?.config]) {
        const config = raw ? AgentConfig.safeParse(raw).data : undefined;
        for (const f of config?.qualificationFields ?? []) {
          const existing = byKey.get(f.key);
          if (existing) {
            if (!existing.agents.includes(a.name)) existing.agents.push(a.name);
            continue;
          }
          byKey.set(f.key, {
            key: f.key,
            label: f.label,
            type: f.type,
            ...(f.options.length ? { options: f.options } : {}),
            agents: [a.name],
          });
        }
      }
    }
    return [...byKey.values(), ...BUILTIN_CRM_SOURCES.map((b) => ({ ...b, agents: [] }))];
  }

  private async crm(tenantId: string, id: string) {
    const integration = await this.integrations.byId(tenantId, id);
    if (!integration || !isCrm(integration.type))
      throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "CRM integration not found");
    return { ...integration, type: integration.type };
  }

  /** What the mapping screen needs: answers, CRM fields, the saved mapping and anything now broken */
  async mappingView(tenantId: string, id: string, refresh: boolean) {
    const crm = await this.crm(tenantId, id);
    const config = CrmConfig.safeParse(crm.config).data ?? { syncLeads: true, mapping: {} };
    const sources = await this.sources(tenantId);
    let properties: CrmProperty[] = [];
    let error: string | null = null;
    try {
      properties = await this.fetchProperties(
        id,
        crm.type,
        crm.credentials as unknown as CrmCredentials,
        refresh,
      );
    } catch (err) {
      error = err instanceof ToolError ? err.message : "Could not read the CRM's fields";
    }
    return {
      syncLeads: config.syncLeads,
      mapping: config.mapping,
      sources,
      properties,
      error,
      problems: properties.length ? validateCrmMapping(config.mapping, sources, properties) : [],
    };
  }

  async saveMapping(auth: AuthContext, id: string, body: SaveCrmMappingBody, meta: Meta) {
    const crm = await this.crm(auth.tenantId, id);
    const sources = await this.sources(auth.tenantId);
    let properties: CrmProperty[];
    try {
      properties = await this.fetchProperties(
        id,
        crm.type,
        crm.credentials as unknown as CrmCredentials,
        true,
      );
    } catch (err) {
      throw new AppException(
        HttpStatus.BAD_GATEWAY,
        "INTEGRATION_ERROR",
        err instanceof ToolError ? err.message : "Could not read the CRM's fields",
      );
    }
    const problems = validateCrmMapping(body.mapping, sources, properties);
    if (problems.length)
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        "VALIDATION_FAILED",
        "Some answers can't go to the chosen CRM fields",
        problems.map((p) => ({ path: `mapping.${p.source}`, message: p.message })),
      );
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const row = await tx.integration.update({
        where: { id },
        data: {
          config: {
            ...(crm.config as object),
            syncLeads: body.syncLeads,
            mapping: body.mapping,
          } as Prisma.InputJsonObject,
        },
        select: { id: true, config: true },
      });
      await this.audit.record(tx, auth, {
        action: "integration.crm_mapping_saved",
        entityType: "integration",
        entityId: id,
        after: body,
        ...meta,
      });
      return row;
    });
  }
}
