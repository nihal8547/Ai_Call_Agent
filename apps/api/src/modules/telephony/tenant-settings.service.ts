import { Injectable } from "@nestjs/common";
import { TenantLimits } from "@platform/shared";
import { TenantDbService } from "../../infra/tenant-db.service";

export type CallSettings = {
  timezone: string;
  callingCode: string;
  maxCallMinutes: number;
  limits: TenantLimits;
  /** Blocked caller patterns: E.164 numbers, or prefixes ending in "*" */
  blocked: string[];
};

const TTL_MS = 30_000;

/** Per-business call settings, read at most every 30 s per API instance */
@Injectable()
export class TenantSettingsService {
  private readonly cache = new Map<string, { at: number; v: CallSettings }>();

  constructor(private readonly tenantDb: TenantDbService) {}

  async get(tenantId: string): Promise<CallSettings> {
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
    const db = this.tenantDb.db(tenantId);
    const [t, blocked] = await Promise.all([
      db.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { timezone: true, callingCode: true, maxCallMinutes: true, usageLimits: true },
      }),
      db.blockedCaller.findMany({ select: { pattern: true } }),
    ]);
    const v: CallSettings = {
      timezone: t.timezone,
      callingCode: t.callingCode,
      maxCallMinutes: t.maxCallMinutes,
      limits: TenantLimits.parse(t.usageLimits ?? {}),
      blocked: blocked.map((b) => b.pattern),
    };
    this.cache.set(tenantId, { at: Date.now(), v });
    return v;
  }

  /** After a settings change on this instance (others catch up within the TTL) */
  forget(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}

export function isBlocked(caller: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.endsWith("*") ? caller.startsWith(p.slice(0, -1)) : caller === p));
}
