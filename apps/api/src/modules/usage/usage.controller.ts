import { Controller, Get, Query } from "@nestjs/common";
import { zonedDateTimeToUtc } from "@platform/core";
import { Prisma } from "@platform/db";
import { UsageSummaryQuery, unitPrice, type UsageKind } from "@platform/shared";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, RequirePermissions } from "../../common/auth/decorators";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TenantDbService } from "../../infra/tenant-db.service";
import { UsageService } from "./usage.service";

/** Metered usage and its estimated cost (billing people only: costs are commercial information) */
@Controller("usage")
export class UsageController {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly usage: UsageService,
  ) {}

  @RequirePermissions("billing:read")
  @Get("summary")
  summary(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(UsageSummaryQuery)) q: z.output<typeof UsageSummaryQuery>,
  ) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: auth.tenantId },
        select: { timezone: true },
      });
      const { from, to } = localRange(q.from, q.to, tenant.timezone);
      const rows = await tx.$queryRaw<
        { kind: UsageKind; provider: string | null; model: string | null; quantity: bigint; cost: bigint }[]
      >(Prisma.sql`
        SELECT kind, provider, model, sum(quantity)::bigint AS quantity, sum(cost_micros)::bigint AS cost
        FROM usage_records
        WHERE created_at >= ${from} AND created_at < ${to}
        GROUP BY 1, 2, 3 ORDER BY cost DESC, kind`);
      const days = await tx.$queryRaw<{ day: string; cost: bigint }[]>(Prisma.sql`
        SELECT to_char(date_trunc('day', created_at AT TIME ZONE ${tenant.timezone}), 'YYYY-MM-DD') AS day,
               sum(cost_micros)::bigint AS cost
        FROM usage_records
        WHERE created_at >= ${from} AND created_at < ${to}
        GROUP BY 1 ORDER BY 1`);
      const lines = rows.map((r) => ({
        kind: r.kind,
        provider: r.provider,
        model: r.model,
        quantity: Number(r.quantity),
        costMicros: Number(r.cost),
        unitPriceMicros: unitPrice(this.usage.prices, r.kind, r.model),
      }));
      return {
        from: q.from,
        to: q.to,
        currency: "USD",
        estimated: true,
        totalMicros: lines.reduce((n, l) => n + l.costMicros, 0),
        lines,
        days: days.map((d) => ({ day: d.day, costMicros: Number(d.cost) })),
      };
    });
  }
}

/** Local calendar days (both inclusive) → the UTC instants they span */
export function localRange(fromDay: string, toDay: string, timezone: string): { from: Date; to: Date } {
  const next = new Date(Date.parse(`${toDay}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return {
    from: zonedDateTimeToUtc(fromDay, "00:00", timezone),
    to: zonedDateTimeToUtc(next, "00:00", timezone),
  };
}
