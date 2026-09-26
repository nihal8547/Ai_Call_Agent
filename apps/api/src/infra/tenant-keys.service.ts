import { Inject, Injectable } from "@nestjs/common";
import { openJson, parseMasterKey, sealJson, unwrapDataKey } from "@platform/crypto";
import { API_ENV, type ApiEnv } from "../config/env";
import { PrismaService } from "./prisma.service";
import { withTenant } from "@platform/db";

const TTL_MS = 5 * 60_000;

/**
 * Envelope encryption for tenant secrets: each tenant's data key (DEK) is stored encrypted with the
 * platform master key and unwrapped only in memory, briefly. Ciphertexts are bound to their purpose
 * (AAD) so one secret can't be swapped in for another.
 */
@Injectable()
export class TenantKeysService {
  private readonly masterKey: Buffer;
  private readonly cache = new Map<string, { dek: Buffer; expiresAt: number }>();

  constructor(
    @Inject(API_ENV) env: ApiEnv,
    private readonly prisma: PrismaService,
  ) {
    this.masterKey = parseMasterKey(env.MASTER_ENCRYPTION_KEY);
  }

  private async dek(tenantId: string): Promise<Buffer> {
    const hit = this.cache.get(tenantId);
    if (hit && hit.expiresAt > Date.now()) return hit.dek;
    const tenant = await withTenant(this.prisma.client, tenantId, (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { encryptedDek: true } }),
    );
    const dek = unwrapDataKey(this.masterKey, Buffer.from(tenant.encryptedDek), tenantId);
    this.cache.set(tenantId, { dek, expiresAt: Date.now() + TTL_MS });
    return dek;
  }

  async seal(tenantId: string, purpose: string, value: unknown): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(sealJson(await this.dek(tenantId), value, `${tenantId}:${purpose}`));
  }

  async open<T>(tenantId: string, purpose: string, payload: Uint8Array): Promise<T> {
    return openJson<T>(await this.dek(tenantId), Buffer.from(payload), `${tenantId}:${purpose}`);
  }
}
