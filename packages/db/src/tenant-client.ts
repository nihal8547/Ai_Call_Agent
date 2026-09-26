import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";

const TenantId = z.uuid();

/** Transaction client with `app.tenant_id` already set */
export type TenantTx = Prisma.TransactionClient;

function assertTenantId(tenantId: string): string {
  const parsed = TenantId.safeParse(tenantId);
  if (!parsed.success) throw new Error(`Invalid tenant id: ${tenantId}`);
  return parsed.data;
}

const setTenant = (tenantId: string) => Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, TRUE)`;

/**
 * Prisma client whose every model operation runs in a transaction that first sets
 * `app.tenant_id`, so PostgreSQL Row-Level Security limits it to one tenant.
 *
 *   const db = tenantClient(prisma, tenantId);
 *   await db.agent.findMany();          // only this tenant's agents
 *
 * Raw queries (`$queryRaw`) are NOT scoped by this client — use `withTenant` for those.
 */
export function tenantClient(prisma: PrismaClient, tenantId: string) {
  const id = assertTenantId(tenantId);
  return prisma.$extends({
    name: "tenant-scope",
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const [, result] = await prisma.$transaction([prisma.$executeRaw(setTenant(id)), query(args)]);
          return result;
        },
      },
    },
  });
}
export type TenantClient = ReturnType<typeof tenantClient>;

/**
 * Run several statements (including raw SQL) in one transaction scoped to a tenant.
 * Use for multi-step writes that must be atomic.
 */
export async function withTenant<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
  options?: { timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> {
  const id = assertTenantId(tenantId);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(setTenant(id));
    return fn(tx);
  }, options);
}
