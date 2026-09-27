import { Prisma, type PrismaClient } from "@prisma/client";
import { withTenant } from "./tenant-client";

const BATCH = 2000;

/**
 * Retention: after `retentionDays`, a call keeps its outcome, timing and cost (for analytics and
 * billing) but loses what was said: its timeline, collected answers, summary and caller number.
 * Leads are business records and are kept. Resolved background-job failures and dismissed alerts
 * go after 90 days. Runs in batches, so a large backlog never holds one long transaction.
 */
export async function purgeExpired(
  prisma: PrismaClient,
  tenantId: string,
  retentionDays: number,
  now = new Date(),
): Promise<{ calls: number; events: number; failedJobs: number; alerts: number }> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const housekeeping = new Date(now.getTime() - 90 * 86_400_000);
  const totals = { calls: 0, events: 0, failedJobs: 0, alerts: 0 };
  for (;;) {
    const done = await withTenant(prisma, tenantId, async (tx) => {
      const ids = (
        await tx.call.findMany({
          where: { startedAt: { lt: cutoff }, NOT: { fromNumber: "redacted" } },
          select: { id: true },
          take: BATCH,
        })
      ).map((c) => c.id);
      if (!ids.length) return true;
      const events = await tx.callEvent.deleteMany({ where: { callId: { in: ids } } });
      await tx.call.updateMany({
        where: { id: { in: ids } },
        data: {
          collectedData: {},
          summary: null,
          sessionSnapshot: Prisma.DbNull,
          fromNumber: "redacted",
          forwardedFrom: null,
        },
      });
      totals.calls += ids.length;
      totals.events += events.count;
      return ids.length < BATCH;
    });
    if (done) break;
  }
  await withTenant(prisma, tenantId, async (tx) => {
    totals.failedJobs = (
      await tx.failedJob.deleteMany({
        where: {
          OR: [
            { status: { not: "FAILED" }, resolvedAt: { lt: housekeeping } },
            { createdAt: { lt: cutoff } },
          ],
        },
      })
    ).count;
    totals.alerts = (await tx.tenantAlert.deleteMany({ where: { acknowledgedAt: { lt: housekeeping } } })).count;
  });
  return totals;
}

/**
 * SIP trunks that are set up with numbers but have taken no call for a day may have broken on the
 * carrier's side (an address change, an expired password): raise an alert for the owner.
 */
export async function checkSilentTrunks(prisma: PrismaClient, tenantId: string, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 86_400_000);
  return withTenant(prisma, tenantId, async (tx) => {
    const silent = await tx.sipTrunk.findMany({
      where: {
        status: "ACTIVE",
        createdAt: { lt: since },
        numbers: { some: {} },
        OR: [{ lastCallAt: null }, { lastCallAt: { lt: since } }],
      },
      select: { id: true, name: true, lastCallAt: true },
    });
    let raised = 0;
    for (const t of silent) {
      const created = await tx.tenantAlert
        .create({
          data: {
            tenantId,
            kind: "sip_trunk_silent",
            dedupeKey: `sip-silent-${t.id}-${now.toISOString().slice(0, 10)}`,
            message: `No calls have arrived on the SIP connection "${t.name}" for over 24 hours. Check it with your carrier or PBX vendor.`,
            data: { sipTrunkId: t.id, lastCallAt: t.lastCallAt?.toISOString() ?? null },
          },
        })
        .then(() => true)
        .catch((err: unknown) => {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
          throw err;
        });
      if (created) raised++;
    }
    return raised;
  });
}
