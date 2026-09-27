import { Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { IdParam } from "@platform/shared";
import { z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, RequirePermissions } from "../../common/auth/decorators";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AlertsService } from "./alerts.service";

const ListQuery = z.object({ open: z.enum(["0", "1"]).default("1") });

@Controller("alerts")
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @RequirePermissions("tenant:read")
  @Get()
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(ListQuery)) q: z.output<typeof ListQuery>,
  ) {
    return { items: await this.alerts.list(auth.tenantId, q.open === "1") };
  }

  @RequirePermissions("tenant:write")
  @Post(":id/acknowledge")
  @HttpCode(204)
  async acknowledge(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
  ): Promise<void> {
    await this.alerts.acknowledge(auth, id);
  }
}
