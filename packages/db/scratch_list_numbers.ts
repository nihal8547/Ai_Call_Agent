import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function run() {
  const nums = await prisma.phoneNumber.findMany();
  console.log("All numbers:", nums.map(n => ({ id: n.id, e164: n.e164, forwardedFrom: n.forwardedFrom })));
}

run().catch(console.error).finally(() => prisma.$disconnect());
