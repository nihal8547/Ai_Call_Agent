import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  BuyTwilioNumberBody,
  ConnectForwardingBody,
  CreatePhoneNumberBody,
  IdParam,
  SearchTwilioNumbersQuery,
  UpdatePhoneNumberBody,
  VerifyNumberBody,
} from "@platform/shared";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, RequirePermissions } from "../../common/auth/decorators";
import { AppException } from "../../common/filters/problem-details.filter";
import { requestMeta } from "../../common/http/request-meta";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RateLimit } from "../../common/rate-limit/rate-limit";
import { TenantDbService } from "../../infra/tenant-db.service";
import { TwilioRestService } from "../../infra/twilio-rest.service";
import { AuditService } from "../audit/audit.service";
import { assertAgent, PHONE_NUMBER_VIEW, PhoneNumbersService } from "./phone-numbers.service";
import { RequireVerifiedEmail } from "../../common/auth/verified-email.guard";

const RemoveQuery = z.object({ release: z.enum(["0", "1"]).default("0") });

@Controller("phone-numbers")
export class PhoneNumbersController {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
    private readonly numbers: PhoneNumbersService,
    private readonly twilio: TwilioRestService,
  ) {}

  @RequirePermissions("phone_numbers:read")
  @Get()
  async list(@CurrentAuth() auth: AuthContext) {
    await this.numbers.expireVerifications(auth.tenantId);
    return { items: await this.numbers.list(auth.tenantId), twilioAccount: Boolean(this.twilio.client) };
  }

  /** Add a Twilio number by hand (development, or the platform operator) */
  @RequirePermissions("phone_numbers:write")
  @Post()
  @RequireVerifiedEmail()
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(CreatePhoneNumberBody)) body: z.output<typeof CreatePhoneNumberBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.numbers.addManual(auth, body, requestMeta(req));
  }

  // ── Buy a Twilio number ─────────────────────────────────────────────────────
  @RequirePermissions("phone_numbers:write")
  @Get("twilio/available")
  @RateLimit({ name: "twilio-search", limit: 30, windowSeconds: 60, by: "ip" })
  async available(
    @Query(new ZodValidationPipe(SearchTwilioNumbersQuery)) q: z.output<typeof SearchTwilioNumbersQuery>,
  ) {
    return { items: await this.numbers.searchTwilio(q) };
  }

  /** Numbers cost money every month, so buying needs billing access too */
  @RequirePermissions("phone_numbers:write", "billing:write")
  @Post("twilio/buy")
  @RequireVerifiedEmail()
  @RateLimit({ name: "twilio-buy", limit: 10, windowSeconds: 3600, by: "ip" })
  buy(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(BuyTwilioNumberBody)) body: z.output<typeof BuyTwilioNumberBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.numbers.buyTwilio(auth, body, requestMeta(req));
  }

  @RequirePermissions("phone_numbers:write")
  @Patch(":id")
  update(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Body(new ZodValidationPipe(UpdatePhoneNumberBody)) body: z.output<typeof UpdatePhoneNumberBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      if (!(await tx.phoneNumber.count({ where: { id } })))
        throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Phone number not found");
      if (body.agentId) await assertAgent(tx, body.agentId);
      const number = await tx.phoneNumber.update({ where: { id }, data: body, select: PHONE_NUMBER_VIEW });
      await this.audit.record(tx, auth, {
        action: "phone_number.updated",
        entityType: "phone_number",
        entityId: id,
        after: body,
        ...requestMeta(req),
      });
      return number;
    });
  }

  /** `release=1` also gives a number bought here back to Twilio, so it stops costing money */
  @RequirePermissions("phone_numbers:write")
  @Delete(":id")
  @HttpCode(204)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Query(new ZodValidationPipe(RemoveQuery)) q: z.output<typeof RemoveQuery>,
    @Req() req: FastifyRequest,
  ): Promise<void> {
    await this.numbers.remove(auth, id, q.release === "1", requestMeta(req));
  }

  // ── The business's existing number (Ooredoo, Vodafone, …) forwarded here ────
  @RequirePermissions("phone_numbers:write")
  @Post(":id/forwarding")
  connectForwarding(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Body(new ZodValidationPipe(ConnectForwardingBody)) body: z.output<typeof ConnectForwardingBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.numbers.connectForwarding(auth, id, body, requestMeta(req));
  }

  @RequirePermissions("phone_numbers:read")
  @Get(":id/forwarding")
  forwarding(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
  ) {
    return this.numbers.instructions(auth.tenantId, id);
  }

  @RequirePermissions("phone_numbers:write")
  @Delete(":id/forwarding")
  disconnectForwarding(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Req() req: FastifyRequest,
  ) {
    return this.numbers.disconnectForwarding(auth, id, requestMeta(req));
  }

  /** Start a 10-minute test: call the business number and the agent confirms the route works */
  @RequirePermissions("phone_numbers:write")
  @Post(":id/verify")
  @HttpCode(200)
  @RateLimit({ name: "number-verify", limit: 10, windowSeconds: 3600, by: "ip" })
  verify(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Body(new ZodValidationPipe(VerifyNumberBody)) body: z.output<typeof VerifyNumberBody>,
  ) {
    return this.numbers.startVerification(auth, id, body.from);
  }
}
