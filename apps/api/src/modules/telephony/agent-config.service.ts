import { Injectable } from "@nestjs/common";
import { readJson } from "@platform/db";
import { AgentConfig } from "@platform/shared";
import { TenantDbService } from "../../infra/tenant-db.service";

type Entry = { config: AgentConfig; timezone: string; fetchedAt: number };

const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 500;

/**
 * Published agent versions are immutable, so their parsed config can be cached per version id.
 * (The tenant time zone is re-read every few minutes.)
 */
@Injectable()
export class AgentConfigService {
  private readonly cache = new Map<string, Entry>();

  constructor(private readonly tenantDb: TenantDbService) {}

  async published(tenantId: string, agentVersionId: string): Promise<Entry> {
    const hit = this.cache.get(agentVersionId);
    if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit;

    const version = await this.tenantDb.db(tenantId).agentVersion.findUniqueOrThrow({
      where: { id: agentVersionId },
      include: { tenant: { select: { timezone: true } } },
    });
    const entry: Entry = {
      config: readJson(AgentConfig, version.config, "agent_versions.config"),
      timezone: version.tenant.timezone,
      fetchedAt: Date.now(),
    };
    if (this.cache.size >= MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(agentVersionId, entry);
    return entry;
  }
}
