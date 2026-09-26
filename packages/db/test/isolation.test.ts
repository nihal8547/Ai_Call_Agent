import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePhoneNumber, userMemberships } from "../src/system";
import { tenantClient, withTenant } from "../src/tenant-client";
import { appClient, createPopulatedTenant, hasDb, ownerClient, TENANT_TABLES } from "./helpers";

/**
 * Tenant isolation is the platform's most important security property.
 * These tests run as the RLS-restricted app role and must never be skipped in CI.
 */
describe.skipIf(!hasDb)("tenant isolation (Row-Level Security)", () => {
  const prisma = appClient();
  const owner = ownerClient();
  let A: Awaited<ReturnType<typeof createPopulatedTenant>>;
  let B: Awaited<ReturnType<typeof createPopulatedTenant>>;

  const countAs = (tenantId: string | null, table: string, column: string, target: string) =>
    tenantId
      ? withTenant(prisma, tenantId, (tx) =>
          tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "${table}" WHERE "${column}" = $1::uuid`,
            target,
          ),
        ).then((r) => Number(r[0]?.n))
      : prisma
          .$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "${table}" WHERE "${column}" = $1::uuid`,
            target,
          )
          .then((r) => Number(r[0]?.n));

  beforeAll(async () => {
    A = await createPopulatedTenant(prisma, "a");
    B = await createPopulatedTenant(prisma, "b");
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await owner.$disconnect();
  });

  it("covers every table that has a tenant_id column, and each has forced RLS + a policy", async () => {
    const rows = await owner.$queryRaw<
      { table_name: string; rls: boolean; forced: boolean; policies: bigint }[]
    >`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname AND p.policyname = 'tenant_isolation') AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND (c.relname = 'tenants' OR EXISTS (
          SELECT 1 FROM information_schema.columns col
          WHERE col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'tenant_id'))`;

    const found = rows.map((r) => r.table_name).sort();
    expect(found).toEqual(TENANT_TABLES.map((t) => t.table).sort());
    for (const r of rows) {
      expect({ table: r.table_name, rls: r.rls, forced: r.forced, policies: Number(r.policies) }).toEqual({
        table: r.table_name,
        rls: true,
        forced: true,
        policies: 1,
      });
    }
  });

  it.each(TENANT_TABLES)("$table: owner tenant sees its row", async ({ table, column }) => {
    expect(await countAs(A.tenantId, table, column, A.tenantId)).toBeGreaterThan(0);
  });

  it.each(TENANT_TABLES)("$table: another tenant sees none of it", async ({ table, column }) => {
    expect(await countAs(B.tenantId, table, column, A.tenantId)).toBe(0);
  });

  it.each(TENANT_TABLES)("$table: no tenant context sees nothing", async ({ table, column }) => {
    expect(await countAs(null, table, column, A.tenantId)).toBe(0);
  });

  it.each(TENANT_TABLES)("$table: another tenant cannot update or delete it", async ({ table, column }) => {
    const [updated, deleted] = await withTenant(prisma, B.tenantId, async (tx) => [
      await tx.$executeRawUnsafe(
        `UPDATE "${table}" SET "${column}" = "${column}" WHERE "${column}" = $1::uuid`,
        A.tenantId,
      ),
      await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "${column}" = $1::uuid`, A.tenantId),
    ]);
    expect([updated, deleted]).toEqual([0, 0]);
    expect(await countAs(A.tenantId, table, column, A.tenantId)).toBeGreaterThan(0);
  });

  it("rejects inserting a row for another tenant", async () => {
    await expect(
      withTenant(prisma, B.tenantId, (tx) =>
        tx.agent.create({ data: { tenantId: A.tenantId, name: "Intruder" } }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("rejects moving a row into another tenant", async () => {
    await expect(
      withTenant(prisma, A.tenantId, (tx) =>
        tx.agent.update({ where: { id: A.agentId }, data: { tenantId: B.tenantId } }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  describe("tenantClient (Prisma API)", () => {
    it("scopes reads to one tenant", async () => {
      const agentsB = await tenantClient(prisma, B.tenantId).agent.findMany();
      expect(agentsB.map((a) => a.tenantId)).toEqual([B.tenantId]);
    });

    it("cannot find, update or delete another tenant's row by id", async () => {
      const db = tenantClient(prisma, B.tenantId);
      await expect(db.lead.findUnique({ where: { id: A.leadId } })).resolves.toBeNull();
      await expect(db.lead.updateMany({ where: { id: A.leadId }, data: { notes: "x" } })).resolves.toEqual({
        count: 0,
      });
      await expect(db.lead.update({ where: { id: A.leadId }, data: { notes: "x" } })).rejects.toBeInstanceOf(
        Prisma.PrismaClientKnownRequestError,
      );
      await expect(db.lead.deleteMany({ where: { id: A.leadId } })).resolves.toEqual({ count: 0 });
    });

    it("does not leak the tenant setting between concurrent requests", async () => {
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) => {
          const t = i % 2 === 0 ? A.tenantId : B.tenantId;
          return tenantClient(prisma, t)
            .agent.findMany({ select: { tenantId: true } })
            .then((rows) => ({ expected: t, got: [...new Set(rows.map((r) => r.tenantId))] }));
        }),
      );
      for (const r of results) expect(r.got).toEqual([r.expected]);
    });

    it("rejects a malformed tenant id before touching the database", () => {
      expect(() => tenantClient(prisma, "1 OR 1=1")).toThrow(/Invalid tenant id/);
    });
  });

  describe("pre-tenant lookups (SECURITY DEFINER)", () => {
    it("routes a phone number to its tenant and agent", async () => {
      await expect(resolvePhoneNumber(prisma, A.phone)).resolves.toMatchObject({
        tenantId: A.tenantId,
        agentId: null, // agent is INACTIVE until published
      });
      await expect(resolvePhoneNumber(prisma, "+10000000000")).resolves.toBeNull();
    });

    it("lists only the user's own memberships", async () => {
      const memberships = await userMemberships(prisma, A.userId);
      expect(memberships).toHaveLength(1);
      expect(memberships[0]).toMatchObject({ tenantId: A.tenantId, roleKey: "OWNER" });
      expect(memberships[0]?.permissions).toContain("billing:write");
    });

    it("hides the migrations table from the app role", async () => {
      await expect(prisma.$queryRaw`SELECT count(*) FROM _prisma_migrations`).rejects.toThrow(
        /permission denied/,
      );
    });
  });
});
