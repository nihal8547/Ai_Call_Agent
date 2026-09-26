import { Injectable } from "@nestjs/common";
import { tenantClient, type TenantClient, type TenantTx, withTenant } from "@platform/db";
import { PrismaService } from "./prisma.service";

/** The only way services reach tenant data: every query runs under the tenant's RLS scope */
@Injectable()
export class TenantDbService {
  constructor(private readonly prisma: PrismaService) {}

  /** Single-statement access: db(tenantId).agent.findMany() */
  db(tenantId: string): TenantClient {
    return tenantClient(this.prisma.client, tenantId);
  }

  /** Multi-statement atomic work (writes + audit log in one transaction) */
  tx<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(this.prisma.client, tenantId, fn);
  }
}
