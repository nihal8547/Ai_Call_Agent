import { Controller, Get, Query, Res } from "@nestjs/common";
import { Prisma } from "@platform/db";
import { AnalyticsRangeQuery, AnalyticsSummaryQuery } from "@platform/shared";
import type { FastifyReply } from "fastify";
import { type z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, RequirePermissions } from "../../common/auth/decorators";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AnalyticsService } from "./analytics.service";

type Totals = {
  calls: bigint;
  answered: bigint;
  completed: bigint;
  failed: bigint;
  qualified: bigint;
  booked: bigint;
  transfers: bigint;
  follow_ups: bigint;
  avg_duration: number | null;
  turns: bigint;
  fallback_turns: bigint;
};

@Controller("analytics")
export class AnalyticsController {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly analytics: AnalyticsService,
  ) {}

  /** The Analytics page: KPIs, daily series, outcomes, funnel, latency, tools, knowledge, cost */
  @RequirePermissions("analytics:read")
  @Get("report")
  report(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(AnalyticsRangeQuery)) q: z.output<typeof AnalyticsRangeQuery>,
  ) {
    return this.analytics.report(auth, q);
  }

  @RequirePermissions("analytics:read")
  @Get("export.csv")
  async exportCsv(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(AnalyticsRangeQuery)) q: z.output<typeof AnalyticsRangeQuery>,
    @Res() reply: FastifyReply,
  ) {
    const body = await this.analytics.csv(auth, q);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="analytics-${q.from}-to-${q.to}.csv"`)
      .header("cache-control", "no-store")
      .send(body);
  }

  /** Dashboard KPIs and a per-day series, bucketed in the business's time zone */
  @RequirePermissions("analytics:read")
  @Get("summary")
  summary(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(AnalyticsSummaryQuery)) q: z.output<typeof AnalyticsSummaryQuery>,
  ) {
    const since = new Date(Date.now() - q.days * 86_400_000);
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: auth.tenantId },
        select: { timezone: true },
      });
      const [totals] = await tx.$queryRaw<Totals[]>(Prisma.sql`
        SELECT count(*)                                                        AS calls,
               count(*) FILTER (WHERE answered_at IS NOT NULL)                 AS answered,
               count(*) FILTER (WHERE status = 'COMPLETED')                    AS completed,
               count(*) FILTER (WHERE status IN ('FAILED','NO_ANSWER','BUSY','CANCELED')) AS failed,
               count(*) FILTER (WHERE qualification_status = 'QUALIFIED')      AS qualified,
               count(*) FILTER (WHERE outcome = 'APPOINTMENT_BOOKED')          AS booked,
               count(*) FILTER (WHERE outcome = 'HUMAN_HANDOFF')               AS transfers,
               count(*) FILTER (WHERE outcome = 'FOLLOW_UP_REQUIRED')          AS follow_ups,
               avg(duration_sec)::float                                        AS avg_duration,
               coalesce(sum(total_turns), 0)                                   AS turns,
               coalesce(sum(fallback_turns), 0)                                AS fallback_turns
        FROM calls WHERE started_at >= ${since}`);
      const series = await tx.$queryRaw<
        { day: string; calls: bigint; booked: bigint; qualified: bigint }[]
      >(Prisma.sql`
        SELECT to_char(date_trunc('day', started_at AT TIME ZONE ${tenant.timezone}), 'YYYY-MM-DD') AS day,
               count(*) AS calls,
               count(*) FILTER (WHERE outcome = 'APPOINTMENT_BOOKED') AS booked,
               count(*) FILTER (WHERE qualification_status = 'QUALIFIED') AS qualified
        FROM calls WHERE started_at >= ${since}
        GROUP BY 1 ORDER BY 1`);
      const leads = await tx.lead.count({ where: { createdAt: { gte: since } } });
      const t = totals!;
      const n = (v: bigint) => Number(v);
      return {
        days: q.days,
        totals: {
          calls: n(t.calls),
          answered: n(t.answered),
          completed: n(t.completed),
          failed: n(t.failed),
          qualified: n(t.qualified),
          booked: n(t.booked),
          transfers: n(t.transfers),
          followUps: n(t.follow_ups),
          leads,
          avgDurationSec: t.avg_duration === null ? null : Math.round(t.avg_duration),
          conversionRate: n(t.calls) ? (n(t.booked) + n(t.qualified)) / 2 / n(t.calls) : 0,
          fallbackRate: n(t.turns) ? n(t.fallback_turns) / n(t.turns) : 0,
        },
        series: fillDays(
          series.map((s) => ({
            day: s.day,
            calls: n(s.calls),
            booked: n(s.booked),
            qualified: n(s.qualified),
          })),
          q.days,
          tenant.timezone,
        ),
      };
    });
  }
}

/** Include days without calls so charts have a continuous axis */
function fillDays(
  rows: { day: string; calls: number; booked: number; qualified: number }[],
  days: number,
  timezone: string,
) {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return Array.from({ length: days }, (_, i) => {
    const day = fmt.format(new Date(Date.now() - (days - 1 - i) * 86_400_000));
    return byDay.get(day) ?? { day, calls: 0, booked: 0, qualified: 0 };
  });
}
