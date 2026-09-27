import { type NestFastifyApplication } from "@nestjs/platform-fastify";
import { checkSilentTrunks, purgeExpired } from "@platform/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../src/infra/prisma.service";
import { TenantDbService } from "../src/infra/tenant-db.service";
import { createTestApp, hasTestDb, registerOwner } from "./support/app";
import { phoneCall, provisionAgent, twilioPost } from "./support/telephony";

describe.skipIf(!hasTestDb)("P12: retention and health checks", () => {
  let app: NestFastifyApplication;
  let owner: Awaited<ReturnType<typeof registerOwner>>;
  const db = () => app.get(TenantDbService).db(owner.me.tenant.id);
  const prisma = () => app.get(PrismaService).client;

  beforeAll(async () => {
    app = await createTestApp();
    owner = await registerOwner(app, "retention");
  });
  afterAll(() => app.close());

  it("forgets what was said after the retention period, keeping outcomes, cost and leads", async () => {
    const clinic = await provisionAgent(app, owner.me.tenant.id, "clinic-reception", {
      workingHours: undefined,
    });
    const old = await phoneCall(app, clinic.e164, ["Priya", "cleaning"]);
    await twilioPost(app, "/telephony/twilio/status", {
      ...old.base,
      CallStatus: "completed",
      CallDuration: "40",
    });
    const fresh = await phoneCall(app, clinic.e164, ["Arjun"]);
    const oldRow = await db().call.findUniqueOrThrow({ where: { providerCallSid: old.callSid } });
    await db().call.update({
      where: { id: oldRow.id },
      data: { startedAt: new Date(Date.now() - 400 * 86_400_000) },
    });

    const r = await purgeExpired(prisma(), owner.me.tenant.id, 365);
    expect(r.calls).toBe(1);
    expect(r.events).toBeGreaterThan(3);
    const purged = await db().call.findUniqueOrThrow({
      where: { id: oldRow.id },
      include: { events: true, leads: true },
    });
    expect(purged).toMatchObject({
      fromNumber: "redacted",
      summary: null,
      collectedData: {},
      outcome: oldRow.outcome,
      durationSec: 40,
    });
    expect(purged.events).toEqual([]);
    expect(purged.leads[0]).toMatchObject({ customerName: "Priya" });
    // Recent calls are untouched, and a second run finds nothing more
    const recent = await db().call.findUniqueOrThrow({
      where: { providerCallSid: fresh.callSid },
      include: { events: true },
    });
    expect(recent.events.length).toBeGreaterThan(0);
    expect((await purgeExpired(prisma(), owner.me.tenant.id, 365)).calls).toBe(0);
  });

  it("raises one alert a day for a SIP connection that went quiet", async () => {
    const trunk = await db().sipTrunk.create({
      data: {
        tenantId: owner.me.tenant.id,
        name: "Vodafone SIP",
        carrier: "vodafone_qa",
        domainName: `ret-${Date.now().toString(36)}`,
        status: "ACTIVE",
        createdAt: new Date(Date.now() - 3 * 86_400_000),
        lastCallAt: new Date(Date.now() - 2 * 86_400_000),
      },
    });
    expect(await checkSilentTrunks(prisma(), owner.me.tenant.id)).toBe(0); // no numbers yet
    await db().phoneNumber.create({
      data: {
        tenantId: owner.me.tenant.id,
        e164: `+97444${Date.now().toString().slice(-6)}`,
        provider: "SIP",
        sipTrunkId: trunk.id,
      },
    });
    expect(await checkSilentTrunks(prisma(), owner.me.tenant.id)).toBe(1);
    expect(await checkSilentTrunks(prisma(), owner.me.tenant.id)).toBe(0);
    const alerts = (await owner.client.get("/api/v1/alerts")).json().items;
    expect(alerts[0]).toMatchObject({
      kind: "sip_trunk_silent",
      message: expect.stringContaining("Vodafone SIP"),
    });
  });
});
