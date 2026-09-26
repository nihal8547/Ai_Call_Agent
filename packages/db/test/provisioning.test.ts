import { unwrapDataKey } from "@platform/crypto";
import { DEFAULT_LEAD_STATUSES, SYSTEM_ROLE_KEYS } from "@platform/shared";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { provisionTenant } from "../src/provisioning";
import { withTenant } from "../src/tenant-client";
import { appClient, hasDb, masterKey } from "./helpers";

describe.skipIf(!hasDb)("provisionTenant", () => {
  const prisma = appClient();
  afterAll(() => prisma.$disconnect());

  it("creates tenant, data key, roles, lead statuses and owner membership atomically", async () => {
    const user = await prisma.user.create({
      data: { email: `${randomUUID()}@x.io`, name: "O", passwordHash: "x" },
    });
    const tenant = await provisionTenant(prisma, masterKey, {
      name: "Sunrise Hotel",
      slug: `sunrise-${randomUUID().slice(0, 6)}`,
      ownerUserId: user.id,
    });

    expect(unwrapDataKey(masterKey, Buffer.from(tenant.encryptedDek), tenant.id)).toHaveLength(32);
    const counts = await withTenant(prisma, tenant.id, async (tx) => ({
      roles: (await tx.role.findMany()).map((r) => r.key).sort(),
      statuses: await tx.leadStatus.count(),
      members: await tx.membership.findMany({ include: { role: true } }),
    }));
    expect(counts.roles).toEqual([...SYSTEM_ROLE_KEYS].sort());
    expect(counts.statuses).toBe(DEFAULT_LEAD_STATUSES.length);
    expect(counts.members.map((m) => [m.userId, m.role.key])).toEqual([[user.id, "OWNER"]]);
  });

  it("validates input", async () => {
    await expect(
      provisionTenant(prisma, masterKey, { name: "X", slug: "Bad Slug!", ownerUserId: randomUUID() }),
    ).rejects.toThrow();
  });

  it("rolls back everything if a step fails", async () => {
    const id = randomUUID();
    await expect(
      provisionTenant(prisma, masterKey, {
        id,
        name: "Ghost",
        slug: `ghost-${id.slice(0, 6)}`,
        ownerUserId: randomUUID(),
      }),
    ).rejects.toThrow(); // owner user does not exist → FK violation on membership
    const tenant = await withTenant(prisma, id, (tx) => tx.tenant.findUnique({ where: { id } }));
    expect(tenant).toBeNull();
  });
});
