/**
 * Idempotent development seed:
 *   - a platform owner user
 *   - two demo businesses on the same platform (proves the core is business-agnostic)
 *       ABC Real Estate  → "Sales Agent"      (+911140000001)
 *       XYZ Clinic       → "Reception Agent"  (+911140000002)
 *
 * Runs through the RLS-restricted app connection (DATABASE_URL), exactly like the API.
 * Agent configurations (qualification fields, workflows) are added by the P3 templates.
 */
import { hashPassword, parseMasterKey } from "@platform/crypto";
import { envPrimitives, parseEnv } from "@platform/shared";
import { z } from "zod";
import { createPrismaClient } from "../src/client";
import { provisionTenant } from "../src/provisioning";
import { withTenant } from "../src/tenant-client";

const env = parseEnv(
  z.object({
    DATABASE_URL: envPrimitives.postgresUrl,
    MASTER_ENCRYPTION_KEY: envPrimitives.key32,
    SEED_OWNER_EMAIL: z.email().default("owner@example.com"),
    SEED_OWNER_PASSWORD: z.string().min(10).default("ChangeMe-Dev-Only-2026!"),
  }),
);

const DEMO_TENANTS = [
  {
    id: "0199a000-0000-7000-8000-00000000000a",
    name: "ABC Real Estate",
    slug: "abc-real-estate",
    industry: "real_estate",
    agent: {
      id: "0199a000-0000-7000-8000-0000000000a1",
      name: "Sales Agent",
      templateKey: "real-estate-ava",
    },
    phone: "+911140000001",
  },
  {
    id: "0199a000-0000-7000-8000-00000000000b",
    name: "XYZ Clinic",
    slug: "xyz-clinic",
    industry: "healthcare",
    agent: {
      id: "0199a000-0000-7000-8000-0000000000b1",
      name: "Reception Agent",
      templateKey: "clinic-reception",
    },
    phone: "+911140000002",
  },
] as const;

async function main(): Promise<void> {
  const prisma = createPrismaClient({ url: env.DATABASE_URL });
  const masterKey = parseMasterKey(env.MASTER_ENCRYPTION_KEY);

  try {
    const owner = await prisma.user.upsert({
      where: { email: env.SEED_OWNER_EMAIL },
      update: {},
      create: {
        email: env.SEED_OWNER_EMAIL,
        name: "Platform Owner",
        passwordHash: await hashPassword(env.SEED_OWNER_PASSWORD),
        isPlatformOwner: true,
      },
    });
    console.warn(`owner user: ${owner.email}`);

    for (const t of DEMO_TENANTS) {
      const exists = await withTenant(prisma, t.id, (tx) => tx.tenant.findUnique({ where: { id: t.id } }));
      if (!exists) {
        await provisionTenant(prisma, masterKey, {
          id: t.id,
          name: t.name,
          slug: t.slug,
          industry: t.industry,
          ownerUserId: owner.id,
        });
      }

      await withTenant(prisma, t.id, async (tx) => {
        await tx.agent.upsert({
          where: { id: t.agent.id },
          update: {},
          create: { id: t.agent.id, tenantId: t.id, name: t.agent.name, templateKey: t.agent.templateKey },
        });
        await tx.phoneNumber.upsert({
          where: { e164: t.phone },
          update: {},
          create: { tenantId: t.id, agentId: t.agent.id, e164: t.phone, friendlyName: `${t.name} demo line` },
        });
      });
      console.warn(`tenant: ${t.name} (${t.slug}) ${exists ? "already existed" : "created"}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
