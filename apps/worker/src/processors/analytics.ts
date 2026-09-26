import { type PrismaClient, rollupAnalytics, tenantsWithCallsSince } from "@platform/db";
import type { Job } from "bullmq";
import type { Logger } from "pino";
import { z } from "zod";

const Payload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rollup"), tenantId: z.uuid(), from: z.iso.datetime(), to: z.iso.datetime() }),
  z.object({ kind: z.literal("sweep"), hours: z.number().int().min(1).max(72) }),
]);

/**
 * Analytics roll-ups. `rollup`: one tenant's hours (queued by the API when a call ends).
 * `sweep`: periodic; every tenant with recent calls, for the last few hours (catches anything a
 * rollup job missed, e.g. a call whose status never arrived).
 */
export function analyticsProcessor(prisma: PrismaClient, logger: Logger) {
  return async (job: Pick<Job, "data" | "id">) => {
    const data = Payload.parse(job.data);
    if (data.kind === "rollup") {
      const r = await rollupAnalytics(prisma, data.tenantId, new Date(data.from), new Date(data.to));
      logger.debug({ tenantId: data.tenantId, ...r }, "analytics rolled up");
      return r;
    }
    const to = new Date();
    const from = new Date(to.getTime() - data.hours * 3_600_000);
    const tenants = await tenantsWithCallsSince(prisma, from);
    let hours = 0;
    for (const tenantId of tenants) hours += (await rollupAnalytics(prisma, tenantId, from, to)).hours;
    logger.info({ tenants: tenants.length, hours }, "analytics sweep done");
    return { tenants: tenants.length, hours };
  };
}
