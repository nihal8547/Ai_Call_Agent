import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import { AddSipNumberBody, CreateSipTrunkBody, IdParam, UpdateSipTrunkBody } from "@platform/shared";
import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, RequirePermissions } from "../../common/auth/decorators";
import { requestMeta } from "../../common/http/request-meta";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RateLimit } from "../../common/rate-limit/rate-limit";
import { SipTrunksService } from "./sip-trunks.service";

/** SIP connections from the business's carrier or PBX */
@Controller("sip-trunks")
export class SipTrunksController {
  constructor(private readonly trunks: SipTrunksService) {}

  @RequirePermissions("phone_numbers:read")
  @Get()
  async list(@CurrentAuth() auth: AuthContext) {
    return { items: await this.trunks.list(auth.tenantId) };
  }

  @RequirePermissions("phone_numbers:write")
  @Post()
  @RateLimit({ name: "sip-trunk-create", limit: 10, windowSeconds: 3600, by: "ip" })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(CreateSipTrunkBody)) body: z.output<typeof CreateSipTrunkBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.trunks.create(auth, body, requestMeta(req));
  }

  @RequirePermissions("phone_numbers:write")
  @Patch(":id")
  update(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Body(new ZodValidationPipe(UpdateSipTrunkBody)) body: z.output<typeof UpdateSipTrunkBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.trunks.update(auth, id, body, requestMeta(req));
  }

  @RequirePermissions("phone_numbers:write")
  @Delete(":id")
  @HttpCode(204)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Req() req: FastifyRequest,
  ): Promise<void> {
    await this.trunks.remove(auth, id, requestMeta(req));
  }

  @RequirePermissions("phone_numbers:write")
  @Post(":id/provision")
  @HttpCode(200)
  provision(@CurrentAuth() auth: AuthContext, @Param(new ZodValidationPipe(IdParam)) { id }: { id: string }) {
    return this.trunks.reprovision(auth.tenantId, id);
  }

  @RequirePermissions("phone_numbers:write")
  @Post(":id/numbers")
  addNumber(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Body(new ZodValidationPipe(AddSipNumberBody)) body: z.output<typeof AddSipNumberBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.trunks.addNumber(auth, id, body, requestMeta(req));
  }

  @RequirePermissions("phone_numbers:read")
  @Get(":id/setup-sheet")
  setup(@CurrentAuth() auth: AuthContext, @Param(new ZodValidationPipe(IdParam)) { id }: { id: string }) {
    return this.trunks.setupSheet(auth.tenantId, id);
  }
}
