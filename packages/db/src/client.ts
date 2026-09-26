import { PrismaClient } from "@prisma/client";

export type CreateClientOptions = {
  url?: string;
  log?: ("query" | "info" | "warn" | "error")[];
};

/**
 * Create a Prisma client. Apps keep exactly one per process.
 *
 * The client must connect as a member of the `app_user` role so that Row-Level Security applies.
 * Use `tenantClient()` / `withTenant()` for tenant data; a bare client sees no tenant rows.
 */
export function createPrismaClient(options: CreateClientOptions = {}): PrismaClient {
  return new PrismaClient({
    ...(options.url ? { datasources: { db: { url: options.url } } } : {}),
    log: options.log ?? ["warn", "error"],
  });
}

/** Cheap connectivity check used by readiness probes */
export async function pingDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}
