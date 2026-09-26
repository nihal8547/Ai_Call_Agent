import { type PrismaClient, type Tenant } from "@prisma/client";
import { generateDataKey } from "@platform/crypto";
import {
  DEFAULT_LEAD_STATUSES,
  SYSTEM_ROLE_KEYS,
  SYSTEM_ROLES,
  TenantLimits,
  TenantSlug,
} from "@platform/shared";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { writeJson } from "./json";
import { withTenant } from "./tenant-client";

export const ProvisionTenantInput = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(2).max(120),
  slug: TenantSlug,
  industry: z.string().trim().max(60).optional(),
  timezone: z.string().min(1).max(64).default("Asia/Kolkata"),
  plan: z.string().max(40).default("free"),
  ownerUserId: z.uuid(),
});
export type ProvisionTenantInput = z.input<typeof ProvisionTenantInput>;

/**
 * Create a tenant with everything it needs to work: encrypted data key, system roles,
 * default lead statuses and the owner membership — atomically, under the tenant's own RLS scope.
 */
export async function provisionTenant(
  prisma: PrismaClient,
  masterKey: Buffer,
  input: ProvisionTenantInput,
): Promise<Tenant> {
  const data = ProvisionTenantInput.parse(input);
  const tenantId = data.id ?? randomUUID();
  const { encryptedDek } = generateDataKey(masterKey, tenantId);

  return withTenant(prisma, tenantId, async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        id: tenantId,
        name: data.name,
        slug: data.slug,
        industry: data.industry ?? null,
        timezone: data.timezone,
        plan: data.plan,
        usageLimits: writeJson(TenantLimits, {}, "tenants.usage_limits"),
        encryptedDek: new Uint8Array(encryptedDek),
      },
    });

    const roles = await Promise.all(
      SYSTEM_ROLE_KEYS.map((key) =>
        tx.role.create({
          data: {
            tenantId,
            key,
            name: SYSTEM_ROLES[key].name,
            permissions: SYSTEM_ROLES[key].permissions,
            isSystem: true,
          },
        }),
      ),
    );

    await tx.leadStatus.createMany({ data: DEFAULT_LEAD_STATUSES.map((s) => ({ ...s, tenantId })) });

    const ownerRole = roles.find((r) => r.key === "OWNER");
    if (!ownerRole) throw new Error("OWNER role missing");
    await tx.membership.create({ data: { tenantId, userId: data.ownerUserId, roleId: ownerRole.id } });

    return tenant;
  });
}
