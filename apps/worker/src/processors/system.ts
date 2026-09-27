import { activeTenants, checkSilentTrunks, type PrismaClient, purgeExpired } from "@platform/db";
import { type Job } from "bullmq";
import type { Logger } from "pino";
import { z } from "zod";

/** Jobs on the `system` queue. Payloads are validated before any work happens. */
export const SystemJob = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noop"), note: z.string().max(200).optional() }),
  /** Nightly: apply every business's retention period */
  z.object({ type: z.literal("retention") }),
  /** Hourly: SIP trunks that went quiet */
  z.object({ type: z.literal("trunk_health") }),
]);
export type SystemJob = z.infer<typeof SystemJob>;

export type SystemDeps = { prisma: PrismaClient; logger: Pick<Logger, "info" | "warn"> };

export async function processSystemJob(
  job: Pick<Job, "data" | "id">,
  deps?: SystemDeps,
): Promise<{ ok: true; type: string; [k: string]: unknown }> {
  const data = SystemJob.parse(job.data);
  switch (data.type) {
    case "noop":
      return { ok: true, type: data.type };
    case "retention": {
      const d = requireDeps(deps);
      const totals = { tenants: 0, calls: 0, events: 0 };
      for (const t of await activeTenants(d.prisma)) {
        try {
          const r = await purgeExpired(d.prisma, t.tenantId, t.retentionDays);
          totals.tenants++;
          totals.calls += r.calls;
          totals.events += r.events;
        } catch (err) {
          // One business failing must not stop the others
          d.logger.warn({ err, tenantId: t.tenantId }, "retention purge failed");
        }
      }
      d.logger.info(totals, "retention purge done");
      return { ok: true, type: data.type, ...totals };
    }
    case "trunk_health": {
      const d = requireDeps(deps);
      let alerts = 0;
      for (const t of await activeTenants(d.prisma)) alerts += await checkSilentTrunks(d.prisma, t.tenantId);
      if (alerts) d.logger.warn({ alerts }, "silent SIP trunks");
      return { ok: true, type: data.type, alerts };
    }
  }
}

function requireDeps(deps: SystemDeps | undefined): SystemDeps {
  if (!deps) throw new Error("This job needs the database");
  return deps;
}
