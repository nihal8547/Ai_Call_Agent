import { PrismaClient } from "@prisma/client";
import { withTenant } from "./src/tenant-client";

const prisma = new PrismaClient();

async function main() {
  const tenantId = "0199a000-0000-7000-8000-00000000000a";
  const numbers = await withTenant(prisma, tenantId, (tx) => tx.phoneNumber.findMany());
  console.log("ABC Real Estate Numbers:", numbers);
}

main().finally(() => prisma.$disconnect());
