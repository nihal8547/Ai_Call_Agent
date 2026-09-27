import { instantiateTemplate } from "@platform/templates";
import { describe, expect, it } from "vitest";
import {
  detectNotInterested,
  detectQuestion,
  detectWantsHuman,
  type EngineContext,
  foldArabic,
  formatAmount,
  formatDateForSpeech,
  formatTimeForSpeech,
  guardOutput,
  matchOption,
  mentionsOption,
  parseDate,
  parseName,
  parseNumber,
  parsePhone,
  parseTime,
  parseYesNo,
} from "../src";
import { converse } from "./support";

/** Monday 28 Sep 2026, 09:00 in Doha — inside Sunday–Thursday hours */
const doha: EngineContext = {
  timezone: "Asia/Qatar",
  now: new Date("2026-09-28T06:00:00Z"),
  defaultCountryCode: "974",
};

describe("Arabic understanding (no AI)", () => {
  it("folds the spellings speech recognition produces", () => {
    expect(foldArabic("أُريدُ إستشارةً في آخرِ الأسبوعِ؟")).toBe("اريد استشاره في اخر الاسبوع?");
  });

  it("reads yes and no, including Gulf forms", () => {
    for (const yes of [
      "نعم",
      "ايوه",
      "إي نعم",
      "أكيد",
      "تمام",
      "صح",
      "زين",
      "لا بأس",
      "إن شاء الله",
      "يعني تمام",
      "إي تمام، أكّد",
      "إي، أكد",
    ])
      expect(parseYesNo(yes), yes).toBe(true);
    for (const no of ["لا", "لأ", "لا شكراً", "مو صحيح", "غلط", "ألغي", "لحظة، غيّر الوقت"])
      expect(parseYesNo(no), no).toBe(false);
    expect(parseYesNo("أي وقت يناسبني")).toBeUndefined();
  });

  it("hears a request for a person, a caller who isn't interested, and questions", () => {
    expect(detectWantsHuman("ابي اكلم موظف لو سمحت")).toBe(true);
    expect(detectWantsHuman("أبغى أتكلم مع الدكتور")).toBe(true);
    expect(detectWantsHuman("حولني على خدمة العملاء")).toBe(true);
    expect(detectWantsHuman("ابي شقة في لوسيل")).toBe(false);
    expect(detectNotInterested("مو مهتم، شكراً")).toBe(true);
    expect(detectNotInterested("الرقم غلط")).toBe(true);
    expect(detectQuestion("كم سعر الشقة في اللؤلؤة")).toBe(true);
    expect(detectQuestion("السلام عليكم، وين موقعكم؟")).toBe(true);
    expect(detectQuestion("هل عندكم مواقف")).toBe(true);
    expect(detectQuestion("شقة في لوسيل")).toBe(false);
  });

  it("parses amounts said in Arabic words or digits", () => {
    expect(parseNumber("خمسين ألف ريال")).toBe(50_000);
    expect(parseNumber("مليون ونص")).toBe(1_500_000);
    expect(parseNumber("ثلاث ملايين")).toBe(3_000_000);
    expect(parseNumber("مية وخمسين ألف")).toBe(150_000);
    expect(parseNumber("٧٥٠ ألف ريال")).toBe(750_000);
    expect(parseNumber("في حدود ٢ مليون")).toBe(2_000_000);
    expect(parseNumber("خمسة وعشرين")).toBe(25);
    expect(parseNumber("ألف")).toBe(1_000);
  });

  it("parses Qatar phone numbers said in Arabic", () => {
    expect(parsePhone("٥٥١٢٣٤٥٦", "974")).toBe("+97455123456");
    expect(parsePhone("خمسة خمسة واحد اثنين ثلاثة أربعة خمسة ستة", "974")).toBe("+97455123456");
  });

  it("parses Arabic dates relative to today in Doha", () => {
    expect(parseDate("بكرة", doha)).toBe("2026-09-29");
    expect(parseDate("بعد بكرة إن شاء الله", doha)).toBe("2026-09-30");
    expect(parseDate("اليوم", doha)).toBe("2026-09-28");
    expect(parseDate("يوم الأحد الجاي", doha)).toBe("2026-10-04");
    expect(parseDate("الخميس", doha)).toBe("2026-10-01");
    expect(parseDate("بعد ثلاث أيام", doha)).toBe("2026-10-01");
    expect(parseDate("١٥ أكتوبر", doha)).toBe("2026-10-15");
    expect(parseDate("الأسبوع الجاي", doha)).toBe("2026-10-05");
  });

  it("parses Arabic times", () => {
    expect(parseTime("الساعة خمسة العصر")).toBe("17:00");
    expect(parseTime("خمس ونص المسا")).toBe("17:30");
    expect(parseTime("عشرة الصبح")).toBe("10:00");
    expect(parseTime("الساعة ٤ م")).toBe("16:00");
    expect(parseTime("ثنتين الظهر")).toBe("14:00");
    expect(parseTime("الظهر")).toBe("12:00");
    expect(parseTime("سبعة إلا ربع")).toBe("18:45");
  });

  it("takes names as said, and doesn't mistake sentences for names", () => {
    expect(parseName("اسمي فاطمة الكواري")).toBe("فاطمة الكواري");
    expect(parseName("معك أحمد، لو سمحت")).toBe("أحمد");
    expect(parseName("خالد")).toBe("خالد");
    expect(parseName("أنا أبي شقة")).toBeUndefined();
  });

  it("matches Arabic options, synonyms and English answers", () => {
    const types = ["شقة", "فيلا", "تاون هاوس", "تجاري"];
    expect(matchOption("أدور على فيلا", types)).toBe("فيلا");
    expect(matchOption("شقه", types)).toBe("شقة");
    expect(matchOption("a villa please", types)).toBe("فيلا");
    expect(matchOption("ابي محل", types)).toBe("تجاري");
    const timeline = ["فوراً", "خلال 3 شهور", "من 3 إلى 6 شهور", "أستكشف فقط"];
    expect(matchOption("بس أشوف الحين", timeline)).toBe("أستكشف فقط");
    expect(matchOption("الحين على طول", timeline)).toBe("فوراً");
    expect(matchOption("خلال ثلاث شهور", timeline)).toBe("خلال 3 شهور");
    expect(mentionsOption("ابي الفيلا", "فيلا")).toBe(true);
  });
});

describe("Arabic speaking", () => {
  it("says amounts, dates and times in Arabic", () => {
    expect(formatAmount(50_000, "QAR", "ar-QA")).toBe("50 ألف ريال");
    expect(formatAmount(1_500_000, "QAR", "ar-QA")).toBe("1.5 مليون ريال");
    expect(formatAmount(12_500, "AED", "ar-AE")).toBe("12,500 درهم");
    expect(formatAmount(1_000_000, "QAR", "ar-QA")).toBe("مليون ريال");
    expect(formatAmount(2_000, "QAR", "ar-QA")).toBe("ألفين ريال");
    expect(formatAmount(50_000, "QAR", "en-GB")).toBe("50,000 riyals");
    expect(formatDateForSpeech("2026-10-04", "ar-QA")).toBe("الأحد، 4 أكتوبر");
    expect(formatTimeForSpeech("17:30", "ar-QA")).toBe("5:30 مساءً");
    expect(formatTimeForSpeech("10:00", "ar-QA")).toBe("10 صباحًا");
  });

  it("guards trim long Arabic replies at a sentence end", () => {
    const long = `${"جملة قصيرة هنا. ".repeat(20)}هل تبي أحجز لك؟ ${"كلام إضافي ".repeat(40)}`;
    const r = guardOutput(long, { maxChars: 350 });
    expect(r.ok).toBe(true);
  });
});

describe("Arabic conversations (no AI)", () => {
  it("Qatar real estate: qualifies the buyer and books a viewing", () => {
    const c = converse(
      instantiateTemplate("qatar-real-estate-ar"),
      [
        "اسمي فاطمة",
        "أدور على فيلا",
        "تقريباً ثلاث ملايين ريال",
        "خلال ثلاث شهور",
        "اللؤلؤة أو لوسيل",
        "تمويل بنكي",
        "الأحد الجاي",
        "الساعة خمسة العصر",
        "ايوه",
      ],
      { context: doha },
    );
    expect(c.outputs[0]!.speech).toBe(
      "هلا وسهلا، معك نورة من الدوحة للعقارات. شكراً لاتصالك! ممكن أعرف اسمك الكريم؟",
    );
    expect(c.last.session.collected).toEqual({
      customer_name: "فاطمة",
      property_type: "فيلا",
      budget: 3_000_000,
      timeline: "خلال 3 شهور",
      preferred_area: "اللؤلؤة أو لوسيل",
      financing: "تمويل بنكي",
      visit_date: "2026-10-04",
      visit_time: "17:00",
    });
    expect(c.transcript).toContain(
      "AGENT: تمام، 3 مليون ريال. متى ناوي تشتري: فوراً، خلال 3 شهور، من 3 إلى 6 شهور، ولا بس تستكشف؟",
    );
    expect(c.transcript).toContain("AGENT: أحجز لك المعاينة يوم الأحد، 4 أكتوبر الساعة 5 مساءً؟");
    expect(c.toolCalls.map((t) => t.tool)).toEqual(["appointments.create", "leads.create"]);
    expect(c.last.session).toMatchObject({ outcome: "APPOINTMENT_BOOKED", qualification: "QUALIFIED" });
  });

  it("Qatar real estate: a question, then 'just looking'", () => {
    const c = converse(
      instantiateTemplate("qatar-real-estate-ar"),
      ["خالد", "شقة", "مليون", "كم سعر الشقق في لوسيل؟", "بس أشوف الحين", "الوكرة", "كاش"],
      { context: doha },
    );
    expect(c.transcript).toContain(
      "AGENT: تمام، مليون ريال. متى ناوي تشتري: فوراً، خلال 3 شهور، من 3 إلى 6 شهور، ولا بس تستكشف؟",
    );
    // Never invents a price: the safe answer, and the question is kept for the team
    expect(c.transcript.join("\n")).toContain("ما عندي هالمعلومة الحين");
    expect(c.last.session.pendingQuestions).toEqual(["كم سعر الشقق في لوسيل؟"]);
    expect(c.last.speech).toContain("بخلي فريقنا يرسل لك تفاصيل المشاريع في الوكرة");
    expect(c.last.session.collected).toMatchObject({ budget: 1_000_000, timeline: "أستكشف فقط" });
    expect(c.last.session.outcome).toBe("FOLLOW_UP_REQUIRED");
  });

  it("Qatar real estate: 'no, make it six in the evening' at the confirmation", () => {
    const c = converse(
      instantiateTemplate("qatar-real-estate-ar"),
      [
        "فاطمة",
        "فيلا",
        "مليونين",
        "فوراً",
        "لوسيل",
        "كاش",
        "بكرة",
        "خمسة العصر",
        "لا، خليها الساعة ستة المسا",
        "تمام",
      ],
      { context: doha },
    );
    expect(c.transcript).toContain(
      "AGENT: تمام، عدّلت وقت المعاينة إلى 6 مساءً. أحجز لك المعاينة يوم الثلاثاء، 29 سبتمبر الساعة 6 مساءً؟",
    );
    expect(c.toolCalls[0]!.input).toMatchObject({
      date: "2026-09-29",
      time: "18:00",
      title: "معاينة: فاطمة",
    });
    expect(c.last.session.outcome).toBe("APPOINTMENT_BOOKED");
  });

  it("Qatar clinic: an emergency goes straight to the front desk", () => {
    const c = converse(instantiateTemplate("qatar-clinic-ar"), ["مريم", "علاج عصب", "عندي ألم شديد"], {
      context: doha,
    });
    expect(c.last.control).toBe("transfer");
    expect(c.last.transferTo).toBe("+97444000099");
    expect(c.last.speech).toBe("بحوّلك لمكتب الاستقبال الحين، لحظة من فضلك.");
  });

  it("Qatar clinic: books, declines a time, rebooks, and takes a phone number", () => {
    const c = converse(
      instantiateTemplate("qatar-clinic-ar"),
      [
        "اسمي سارة",
        "تنظيف",
        "مو مستعجلة، وقتي مرن",
        "بكرة",
        "عشرة الصبح",
        "لا",
        "بعد بكرة",
        "الساعة ٤ م",
        "نعم",
        "٥٥١٢٣٤٥٦",
      ],
      { context: doha },
    );
    expect(c.transcript).toContain("AGENT: ولا يهمك، خلنا نغيّرها. أي يوم يناسبك تجي؟");
    expect(c.last.session.collected).toMatchObject({
      patient_name: "سارة",
      service_required: "تنظيف الأسنان",
      urgency: "مرن",
      preferred_date: "2026-09-30",
      preferred_time: "16:00",
      phone: "+97455123456",
    });
    expect(c.last.session.outcome).toBe("APPOINTMENT_BOOKED");
  });

  it("asks for a person in Arabic mid-call, and ends politely when not interested", () => {
    const human = converse(instantiateTemplate("qatar-real-estate-ar"), ["أبغى أكلم موظف"], {
      context: doha,
    });
    expect(human.last.session.handoff.requested).toBe(true);
    expect(human.last.speech).toBe("فريقنا مو متوفر الحين. سجلت بياناتك وبيتصل فيك أحد قريب.");
    const bye = converse(instantiateTemplate("qatar-real-estate-ar"), ["مو مهتم، شكراً"], { context: doha });
    expect(bye.last.speech).toBe("ولا يهمك. شكراً على وقتك، مع السلامة!");
    expect(bye.last.control).toBe("hangup");
  });

  it("picks up several answers in one sentence, as callers really talk", () => {
    const c = converse(
      instantiateTemplate("qatar-real-estate-ar"),
      [
        "السلام عليكم، معك محمد الكبيسي",
        "أبي فيلا في لوسيل، وميزانيتي حول مليونين ونص",
        "مستعجل، على طول",
        "لوسيل",
        "بتمويل من البنك",
      ],
      { context: doha },
    );
    expect(c.last.session.collected).toMatchObject({
      customer_name: "محمد الكبيسي",
      property_type: "فيلا",
      budget: 2_500_000,
      timeline: "فوراً",
      financing: "تمويل بنكي",
    });
    // The budget was never asked for: it came with the property type
    expect(c.transcript.some((l) => l.includes("كم الميزانية"))).toBe(false);
  });

  it("English callers still work on an Arabic agent", () => {
    const c = converse(
      instantiateTemplate("qatar-real-estate-ar"),
      ["My name is John", "a villa", "2 million"],
      {
        context: doha,
      },
    );
    expect(c.last.session.collected).toMatchObject({
      customer_name: "John",
      property_type: "فيلا",
      budget: 2_000_000,
    });
  });
});
