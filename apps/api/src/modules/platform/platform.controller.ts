import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { PlatformPlanBody, PlatformStatusBody, PlatformTenantsQuery } from "@platform/shared";
import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { AnyAuthenticated, CurrentAuth, UserOnly } from "../../common/auth/decorators";
import { requestMeta } from "../../common/http/request-meta";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PlatformService } from "./platform.service";

/** The platform operator's console (platform owners only; checked on every route) */
@AnyAuthenticated()
@UserOnly()
@Controller("platform")
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get("tenants")
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(PlatformTenantsQuery)) q: z.output<typeof PlatformTenantsQuery>,
  ) {
    return this.platform.list(auth, q);
  }

  @Get("tenants/:id")
  get(@CurrentAuth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.platform.get(auth, id);
  }

  @Post("tenants/:id/status")
  @HttpCode(200)
  setStatus(
    @CurrentAuth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(PlatformStatusBody)) body: z.output<typeof PlatformStatusBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.platform.setStatus(auth, id, body, requestMeta(req));
  }

  @Patch("tenants/:id")
  setPlan(
    @CurrentAuth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(PlatformPlanBody)) body: z.output<typeof PlatformPlanBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.platform.setPlan(auth, id, body, requestMeta(req));
  }
}
