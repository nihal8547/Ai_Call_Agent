import { describe, expect, it } from "vitest";
import { fmtBytes, fmtDateTime, fmtDuration, fmtSource, fmtValue, humanize, plural } from "../src/lib/format";

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
