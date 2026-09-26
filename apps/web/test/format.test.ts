import { describe, expect, it } from "vitest";
import { fmtDateTime, fmtDuration, fmtValue, humanize, plural } from "../src/lib/format";

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
});
