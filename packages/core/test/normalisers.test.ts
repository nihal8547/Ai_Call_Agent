import { describe, expect, it } from "vitest";
import {
  detectNotInterested,
  detectQuestion,
  detectWantsHuman,
  formatAmount,
  formatDateForSpeech,
  formatTimeForSpeech,
  matchOption,
  parseDate,
  parseEmail,
  parseName,
  parseNumber,
  parsePhone,
  parseTime,
  parseYesNo,
  stripFillers,
  zonedDateTimeToUtc,
} from "../src/normalisers";

describe("parseNumber", () => {
  it.each([
    ["80 lakh", 8_000_000],
    ["around 80 lakhs", 8_000_000],
    ["eighty lakh", 8_000_000],
    ["1.2 crore", 12_000_000],
    ["one point five crore", 15_000_000],
    ["2 crores", 20_000_000],
    ["50k", 50_000],
    ["fifty thousand rupees", 50_000],
    ["eighty five thousand", 85_000],
    ["one hundred twenty", 120],
    ["₹1,20,000", 120_000],
    ["80 to 90 lakh", 8_000_000],
    ["a million dollars", 1_000_000],
    ["three", 3],
    ["we are 4 people", 4],
    ["two and a half lakh", 250_000],
  ])("%s → %d", (input, expected) => {
    expect(parseNumber(input)).toBe(expected);
  });

  it("returns undefined without a number", () => {
    expect(parseNumber("I'm not sure yet")).toBeUndefined();
    expect(parseNumber("an apartment")).toBeUndefined();
  });

  it("formats amounts for speech", () => {
    expect(formatAmount(8_000_000)).toBe("80 lakh rupees");
    expect(formatAmount(12_000_000)).toBe("1.2 crore rupees");
    expect(formatAmount(50_000)).toBe("50,000 rupees");
    expect(formatAmount(2_500_000, "USD")).toBe("2.5 million dollars");
  });
});

describe("parseDate (Asia/Kolkata, today = Saturday 2026-09-26)", () => {
  const ctx = { timezone: "Asia/Kolkata", now: new Date("2026-09-26T06:00:00Z") };
  it.each([
    ["today", "2026-09-26"],
    ["tomorrow", "2026-09-27"],
    ["day after tomorrow", "2026-09-28"],
    ["monday", "2026-09-28"],
    ["next friday", "2026-10-02"],
    ["this saturday", "2026-09-26"],
    ["saturday", "2026-10-03"],
    ["in 3 days", "2026-09-29"],
    ["12th october", "2026-10-12"],
    ["October 12", "2026-10-12"],
    ["the fifth of january", "2027-01-05"],
    ["on 3rd march 2027", "2027-03-03"],
    ["15/10", "2026-10-15"],
    ["2026-11-02", "2026-11-02"],
    ["on the 30th", "2026-09-30"],
    ["on the 5th", "2026-10-05"],
  ])("%s → %s", (input, expected) => {
    expect(parseDate(input, ctx)).toBe(expected);
  });

  it("uses the business time zone for 'today'", () => {
    // 20:00 UTC on the 26th is already the 27th in India
    expect(parseDate("today", { timezone: "Asia/Kolkata", now: new Date("2026-09-26T20:00:00Z") })).toBe(
      "2026-09-27",
    );
    expect(parseDate("today", { timezone: "America/New_York", now: new Date("2026-09-26T20:00:00Z") })).toBe(
      "2026-09-26",
    );
  });

  it("rejects impossible dates and non-dates", () => {
    expect(parseDate("31st february", ctx)).toBeUndefined();
    expect(parseDate("whenever", ctx)).toBeUndefined();
  });

  it("formats for speech", () => {
    expect(formatDateForSpeech("2026-10-12")).toBe("Monday, 12 October");
  });
});

describe("parseTime", () => {
  it.each([
    ["5 pm", "17:00"],
    ["5:30 pm", "17:30"],
    ["at 5:30", "17:30"],
    ["17:45", "17:45"],
    ["10 am", "10:00"],
    ["around 11", "11:00"],
    ["at 4", "16:00"],
    ["half past five", "17:30"],
    ["quarter to six", "17:45"],
    ["six in the evening", "18:00"],
    ["nine in the morning", "09:00"],
    ["12 pm", "12:00"],
    ["noon", "12:00"],
    ["morning", "10:00"],
    ["evening is better", "17:00"],
    ["5 o'clock", "17:00"],
  ])("%s → %s", (input, expected) => {
    expect(parseTime(input)).toBe(expected);
  });

  it("formats for speech", () => {
    expect(formatTimeForSpeech("17:30")).toBe("5:30 PM");
    expect(formatTimeForSpeech("09:00")).toBe("9 AM");
    expect(formatTimeForSpeech("00:15")).toBe("12:15 AM");
  });
});

describe("matchOption", () => {
  const property = ["Apartment", "Villa", "Plot", "Commercial"];
  const timeline = ["Immediately", "Within 3 months", "3 to 6 months", "Just exploring"];
  it.each([
    ["an apartment please", property, "Apartment"],
    ["looking for a 2bhk flat", property, "Apartment"],
    ["villa", property, "Villa"],
    ["within 3 months", timeline, "Within 3 months"],
    ["3 to 6 months", timeline, "3 to 6 months"],
    ["just exploring for now", timeline, "Just exploring"],
    ["we are only browsing", timeline, "Just exploring"],
    ["asap", timeline, "Immediately"],
    ["home loan from the bank", ["Bank loan", "Own funds", "Need assistance"], "Bank loan"],
    ["I will pay cash", ["Bank loan", "Own funds", "Need assistance"], "Own funds"],
    ["root canal", ["General consultation", "Dental cleaning", "Root canal"], "Root canal"],
    ["cleaning", ["General consultation", "Dental cleaning", "Root canal"], "Dental cleaning"],
  ])("%s → %s", (input, options, expected) => {
    expect(matchOption(input, options)).toBe(expected);
  });

  it("returns undefined when nothing fits", () => {
    expect(matchOption("a houseboat", property)).toBeUndefined();
  });
});

describe("contact details", () => {
  it.each([
    ["98765 43210", "+919876543210"],
    ["+1 415 555 0100", "+14155550100"],
    ["09876543210", "+919876543210"],
    ["nine eight seven six five four three two one zero", "+919876543210"],
    ["double nine eight seven six five four three two one", "+919987654321"],
    ["919876543210", "+919876543210"],
    ["0091 98765 43210", "+919876543210"],
  ])("phone %s → %s", (input, expected) => {
    expect(parsePhone(input)).toBe(expected);
  });

  it.each([
    ["5512 3456", "+97455123456"],
    ["4412 3456", "+97444123456"],
    ["+974 5512 3456", "+97455123456"],
    ["00974 5512 3456", "+97455123456"],
    ["974 55123456", "+97455123456"],
    ["٥٥١٢٣٤٥٦", "+97455123456"],
    ["five five one two three four five six", "+97455123456"],
    ["551234", undefined],
    ["98765 43210", undefined],
  ])("Qatar phone %s → %s", (input, expected) => {
    expect(parsePhone(input, "974")).toBe(expected);
  });

  it("parses spoken emails", () => {
    expect(parseEmail("john dot doe at gmail dot com")).toBe("john.doe@gmail.com");
    expect(parseEmail("my email is asha at the rate example dot in")).toBe("asha@example.in");
    expect(parseEmail("not an email")).toBeUndefined();
  });

  it.each([
    ["My name is Rahul Sharma", "Rahul Sharma"],
    ["this is priya", "Priya"],
    ["I'm Anand here", "Anand"],
    ["Meera", "Meera"],
    ["yes it's john d'souza", "John D'Souza"],
  ])("name %s → %s", (input, expected) => {
    expect(parseName(input)).toBe(expected);
  });
});

describe("intent signals", () => {
  it("yes / no", () => {
    for (const y of ["yes", "Yeah sure", "ok go ahead", "that's right", "haan"])
      expect(parseYesNo(y)).toBe(true);
    for (const n of ["no", "nope, change it", "not now", "cancel", "nahi"]) expect(parseYesNo(n)).toBe(false);
    expect(parseYesNo("maybe tuesday")).toBeUndefined();
  });

  it("wants a human, not interested, question", () => {
    expect(detectWantsHuman("can I talk to a real person")).toBe(true);
    expect(detectWantsHuman("please connect me to the doctor")).toBe(true);
    expect(detectWantsHuman("I am a real estate agent")).toBe(false);
    expect(detectNotInterested("sorry, not interested")).toBe(true);
    expect(detectQuestion("do you have parking")).toBe(true);
    expect(detectQuestion("what are your timings?")).toBe(true);
    expect(detectQuestion("80 lakh")).toBe(false);
  });

  it("strips fillers", () => {
    expect(stripFillers("Um, I'm looking for Baner or Wakad.")).toBe("baner or wakad");
  });
});

describe("zonedDateTimeToUtc", () => {
  it("converts business wall-clock time to UTC, including DST zones", () => {
    expect(zonedDateTimeToUtc("2026-10-03", "17:00", "Asia/Kolkata").toISOString()).toBe(
      "2026-10-03T11:30:00.000Z",
    );
    expect(zonedDateTimeToUtc("2026-07-01", "09:00", "America/New_York").toISOString()).toBe(
      "2026-07-01T13:00:00.000Z",
    );
    expect(zonedDateTimeToUtc("2026-12-01", "09:00", "America/New_York").toISOString()).toBe(
      "2026-12-01T14:00:00.000Z",
    );
  });
});
