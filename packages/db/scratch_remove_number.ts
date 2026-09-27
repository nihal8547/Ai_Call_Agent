import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function run() {
  const num = await prisma.phoneNumber.findFirst({
    where: { forwardedFrom: { contains: "30954643" } }
  });

  if (!num) {
    console.log("Number not found in forwardedFrom.");
    // try e164
    const direct = await prisma.phoneNumber.findFirst({
      where: { e164: { contains: "30954643" } }
    });
    if (direct) {
      console.log("Found as direct Twilio number", direct.e164);
      await prisma.phoneNumber.delete({ where: { id: direct.id } });
      console.log("Deleted direct number.");
    }
    return;
  }

  console.log("Found number being forwarded from:", num.forwardedFrom);
  await prisma.phoneNumber.update({
    where: { id: num.id },
    data: {
      forwardedFrom: null,
      carrier: null,
      forwardingMode: "NO_ANSWER_BUSY_UNREACHABLE",
      verificationStatus: "NONE",
      verifiedAt: null,
      verificationExpiresAt: null,
      verification: {}
    }
  });
  console.log("Successfully removed forwarding for +974 30954643.");
}

run().catch(console.error).finally(() => prisma.$disconnect());
