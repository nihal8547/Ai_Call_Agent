import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { randomInt } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantDbService } from "../src/infra/tenant-db.service";
import { Client, createTestApp, hasTestDb, STRONG_PASSWORD, uniqueEmail } from "./support/app";
import { phoneCall, provisionAgent } from "./support/telephony";

const QATAR_CALLER = `+9745${randomInt(1_000_000, 9_999_999)}`;

describe.skipIf(!hasTestDb)("Arabic agents on real phone calls (Twilio webhooks)", () => {
  let app: NestFastifyApplication;
  let tenantId: string;

  beforeAll(async () => {
    app = await createTestApp();
    const client = new Client(app);
    const res = await client.post("/api/v1/auth/register", {
      name: "Noura",
      email: uniqueEmail("qatar"),
      password: STRONG_PASSWORD,
      acceptTerms: true,
      businessName: "Doha Homes",
      country: "QA",
    });
    expect(res.statusCode).toBe(201);
    tenantId = res.json().tenant.id;
  });
  afterAll(() => app?.close());

  it("speaks Arabic with an Arabic voice and recognises ar-QA speech, then books and saves the lead", async () => {
    const agent = await provisionAgent(app, tenantId, "qatar-real-estate-ar");
    const call = await phoneCall(
      app,
      agent.e164,
      [
        "اسمي فاطمة",
        "أدور على فيلا",
        "تقريباً ثلاث ملايين ريال",
        "خلال ثلاث شهور",
        "لوسيل",
        "كاش",
        "الأحد الجاي",
        "الساعة عشرة الصبح",
        "ايوه",
      ],
      undefined,
      { From: QATAR_CALLER },
    );
    const first = call.replies[0]!;
    expect(first.say).toBe("هلا وسهلا، معك نورة من الدوحة للعقارات. شكراً لاتصالك! ممكن أعرف اسمك الكريم؟");
    expect(first.xml).toContain('voice="Polly.Hala-Neural"');
    expect(first.xml).toMatch(/<Gather[^>]* language="ar-QA"/);
    expect(call.replies.map((r) => r.say)).toContain(
      "تمام، 3 مليون ريال. متى ناوي تشتري: فوراً، خلال 3 شهور، من 3 إلى 6 شهور، ولا بس تستكشف؟",
    );
    expect(call.last.say).toMatch(/^تم! حجزت لك المعاينة يوم الأحد، \d+ \S+ الساعة 10 صباحًا\./);
    expect(call.last.hangup).toBe(true);

    const db = app.get(TenantDbService).db(tenantId);
    const row = await db.call.findUniqueOrThrow({ where: { providerCallSid: call.callSid } });
    expect(row.outcome).toBe("APPOINTMENT_BOOKED");
    expect(row.collectedData).toMatchObject({
      customer_name: "فاطمة",
      property_type: "فيلا",
      budget: 3_000_000,
      timeline: "خلال 3 شهور",
      financing: "كاش",
      visit_time: "10:00",
    });
    // The summary is written in Arabic, with the day as people say it
    expect(row.summary).toMatch(/^الاسم: فاطمة؛ نوع العقار: فيلا؛ .*يوم المعاينة: الأحد، \d+ /);
    const lead = await db.lead.findFirstOrThrow({ where: { callId: row.id } });
    expect(lead.customerName).toBe("فاطمة");
    // A +974 caller is saved as a Qatar number
    expect(lead.phone).toBe(QATAR_CALLER);
  });

  it("an Arabic agent left on an English voice still gets an Arabic voice", async () => {
    const agent = await provisionAgent(app, tenantId, "qatar-clinic-ar", {
      voice: { provider: "twilio", voice: "Polly.Kajal-Neural", speed: 1 },
    });
    const call = await phoneCall(app, agent.e164, [], undefined, { From: QATAR_CALLER });
    expect(call.replies[0]!.xml).toContain('voice="Polly.Hala-Neural"');
  });

  it("asking for a person in Arabic transfers the call", async () => {
    const agent = await provisionAgent(app, tenantId, "qatar-clinic-ar", {
      // Always open, so the transfer isn't refused as out of hours
      workingHours: undefined,
    });
    const call = await phoneCall(app, agent.e164, ["أبغى أكلم موظف لو سمحت"], undefined, {
      From: QATAR_CALLER,
    });
    expect(call.last.say).toBe("بحوّلك لمكتب الاستقبال الحين، لحظة من فضلك.");
    expect(call.last.dial).toBe("+97444000099");
  });
});
