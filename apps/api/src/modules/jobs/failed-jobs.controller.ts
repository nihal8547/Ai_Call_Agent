import { Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { FailedJobsQuery, IdParam } from "@platform/shared";
import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, RequirePermissions } from "../../common/auth/decorators";
import { requestMeta } from "../../common/http/request-meta";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { DeadLetterService } from "./dead-letter.service";

/** Deliveries (webhooks, emails, CRM syncs) that failed after every retry */
@Controller("jobs/failed")
export class FailedJobsController {
  constructor(private readonly deadLetter: DeadLetterService) {}

  @RequirePermissions("integrations:read")
  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(FailedJobsQuery)) q: z.output<typeof FailedJobsQuery>,
  ) {
    return this.deadLetter.list(auth.tenantId, q.status, q.limit);
  }

  @RequirePermissions("integrations:write")
  @Post(":id/retry")
  @HttpCode(200)
  retry(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Req() req: FastifyRequest,
  ) {
    return this.deadLetter.retry(auth, id, requestMeta(req));
  }

  @RequirePermissions("integrations:write")
  @Post(":id/dismiss")
  @HttpCode(200)
  dismiss(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Req() req: FastifyRequest,
  ) {
    return this.deadLetter.dismiss(auth, id, requestMeta(req));
  }
}
