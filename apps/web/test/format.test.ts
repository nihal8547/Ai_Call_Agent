import { describe, expect, it } from "vitest";
import { fmtBytes, fmtDateTime, fmtDuration, fmtSource, fmtValue, humanize, plural } from "../src/lib/format";
import { addDays, localDate, localTime, weekStart, zonedToUtc } from "../src/lib/tz";

describe("format helpers", () => {
  it("humanises enum values and pluralises counts", () => {
    expect(humanize("APPOINTMENT_BOOKED")).toBe("Appointment booked");
    expect(plural(1, "call")).toBe("1 call");
    expect(plural(3, "call")).toBe("3 calls");
  });

  it("formats durations and collected values", () => {
    expect(fmtDuration(84)).toBe("1m 24s");
    expect(fmtDuration(9)).toBe("9s");
    expect(fmtDuration(null)).toBe("—");
    expect(fmtValue(true)).toBe("Yes");
    expect(fmtValue(["a", "b"])).toBe("a, b");
    expect(fmtValue(8000000)).toBe("80,00,000");
  });

  it("shows business-local times in the business time zone", () => {
    const iso = "2026-09-28T05:30:00.000Z";
    expect(fmtDateTime(iso, "Asia/Kolkata")).toMatch(/11:00/);
    expect(fmtDateTime(null)).toBe("—");
  });

  it("formats file sizes and chunk sources", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(25 * 1024 * 1024)).toBe("25 MB");
    expect(fmtSource({ page: 3, headingPath: ["Pricing", "Implants"] })).toBe("Page 3 · Pricing › Implants");
    expect(fmtSource({ pages: [2, 3] })).toBe("Pages 2–3");
    expect(fmtSource({ sheet: "Rooms", rows: [2, 9] })).toBe("Sheet Rooms · Rows 2–9");
  });
});

describe("business time zone helpers", () => {
  it("finds weeks and converts wall-clock times", () => {
    expect(weekStart("2026-10-04")).toBe("2026-09-28"); // Sunday → Monday before
    expect(weekStart("2026-09-28")).toBe("2026-09-28");
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(zonedToUtc("2026-09-29", "10:00", "Asia/Kolkata").toISOString()).toBe("2026-09-29T04:30:00.000Z");
    // Across a DST change (New York, 1 Nov 2026)
    expect(zonedToUtc("2026-11-01", "12:00", "America/New_York").toISOString()).toBe(
      "2026-11-01T17:00:00.000Z",
    );
    const at = new Date("2026-09-28T20:00:00Z");
    expect(localDate(at, "Asia/Kolkata")).toBe("2026-09-29");
    expect(localTime(at, "Asia/Kolkata")).toBe("01:30");
  });
});
