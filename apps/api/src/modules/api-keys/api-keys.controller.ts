import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req } from "@nestjs/common";
import { randomToken, sha256Hex } from "@platform/crypto";
import { CreateApiKeyBody, IdParam } from "@platform/shared";
import type { FastifyRequest } from "fastify";
import { type z } from "zod";
import type { AuthContext } from "../../common/auth/auth.types";
import { CurrentAuth, RequirePermissions, UserOnly } from "../../common/auth/decorators";
import { AppException } from "../../common/filters/problem-details.filter";
import { requestMeta } from "../../common/http/request-meta";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TenantDbService } from "../../infra/tenant-db.service";
import { AuditService } from "../audit/audit.service";
import { assertCanGrant } from "../users/access-policy";

const keyView = {
  id: true,
  name: true,
  prefix: true,
  scopes: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

/** API keys are managed by people only (a key cannot mint keys) */
@Controller("api-keys")
@UserOnly()
export class ApiKeysController {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
  ) {}

  @RequirePermissions("api_keys:read")
  @Get()
  async list(@CurrentAuth() auth: AuthContext) {
    return {
      items: await this.tenantDb
        .db(auth.tenantId)
        .apiKey.findMany({ select: keyView, orderBy: { createdAt: "desc" } }),
    };
  }

  /** The full key is returned only in this response */
  @RequirePermissions("api_keys:write")
  @Post()
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(CreateApiKeyBody)) body: z.output<typeof CreateApiKeyBody>,
    @Req() req: FastifyRequest,
  ) {
    assertCanGrant(auth, body.scopes);
    const prefix = `vk_${randomToken(6).slice(0, 8)}`;
    const key = `${prefix}_${randomToken(32)}`;
    return this.tenantDb.tx(auth.tenantId, async (tx) => {
      const created = await tx.apiKey.create({
        data: {
          tenantId: auth.tenantId,
          name: body.name,
          prefix,
          keyHash: sha256Hex(key),
          scopes: body.scopes,
          expiresAt: body.expiresAt ?? null,
        },
        select: keyView,
      });
      await this.audit.record(tx, auth, {
        action: "api_key.created",
        entityType: "api_key",
        entityId: created.id,
        after: { name: body.name, scopes: body.scopes },
        ...requestMeta(req),
      });
      return { ...created, key };
    });
  }

  @RequirePermissions("api_keys:write")
  @Delete(":id")
  @HttpCode(204)
  async revoke(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(IdParam)) { id }: { id: string },
    @Req() req: FastifyRequest,
  ): Promise<void> {
    await this.tenantDb.tx(auth.tenantId, async (tx) => {
      const { count } = await tx.apiKey.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (!count) throw new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", "API key not found");
      await this.audit.record(tx, auth, {
        action: "api_key.revoked",
        entityType: "api_key",
        entityId: id,
        ...requestMeta(req),
      });
    });
  }
}
