import { QualificationField } from "@platform/shared";
import { describe, expect, it } from "vitest";
import { buildExtractionJsonSchema, isOpen, validateFieldValue } from "../src";
import { clinic, ctx } from "./support";

const field = (f: Record<string, unknown>) =>
  QualificationField.parse({ label: "X", question: "Question?", key: "x_field", ...f });

describe("validateFieldValue", () => {
  it("coerces LLM and spoken values the same way", () => {
    const budget = field({ type: "currency", validation: { min: 500000 } });
    expect(validateFieldValue(budget, 8000000, ctx)).toEqual({ ok: true, value: 8000000 });
    expect(validateFieldValue(budget, "80 lakh", ctx)).toEqual({ ok: true, value: 8000000 });
    expect(validateFieldValue(budget, "5000", ctx)).toEqual({ ok: false, error: "must be at least 500000" });
  });

  it("only accepts configured options", () => {
    const f = field({ type: "select", options: ["Standard", "Deluxe"] });
    expect(validateFieldValue(f, "the deluxe one", ctx)).toEqual({ ok: true, value: "Deluxe" });
    expect(validateFieldValue(f, "penthouse", ctx).ok).toBe(false);
  });

  it("enforces futureOnly dates in the business time zone", () => {
    const f = field({ type: "date", validation: { futureOnly: true } });
    expect(validateFieldValue(f, "2026-09-20", ctx).ok).toBe(false);
    expect(validateFieldValue(f, "today", ctx)).toEqual({ ok: true, value: "2026-09-28" });
  });

  it("applies text patterns and lengths", () => {
    const f = field({ type: "text", validation: { pattern: "^[A-Z]{2}\\d{2}", maxLength: 10 } });
    expect(validateFieldValue(f, "MH12 AB", ctx)).toEqual({ ok: true, value: "MH12 AB" });
    expect(validateFieldValue(f, "12MH", ctx).ok).toBe(false);
  });

  it("rejects empty values", () => {
    expect(validateFieldValue(field({ type: "text" }), "   ", ctx)).toEqual({ ok: false, error: "empty" });
  });
});

describe("buildExtractionJsonSchema", () => {
  it("exposes every field as optional with type-specific shapes", () => {
    const schema = buildExtractionJsonSchema(clinic().qualificationFields) as {
      properties: { fields: { properties: Record<string, { type: unknown; enum?: unknown[] }> } };
    };
    const props = schema.properties.fields.properties;
    expect(Object.keys(props)).toEqual([
      "patient_name",
      "service_required",
      "urgency",
      "preferred_date",
      "preferred_time",
    ]);
    expect(props.urgency!.enum).toEqual(["Emergency", "Within a week", "Flexible", null]);
    expect(props.patient_name!.type).toEqual(["string", "null"]);
  });
});

describe("isOpen", () => {
  const hours = clinic().workingHours;
  it.each([
    ["2026-09-28T06:00:00Z", true], // Mon 11:30 IST
    ["2026-09-28T14:00:00Z", false], // Mon 19:30 IST (closes 19:00)
    ["2026-10-03T05:00:00Z", true], // Sat 10:30 IST
    ["2026-10-03T09:00:00Z", false], // Sat 14:30 IST
    ["2026-10-04T06:00:00Z", false], // Sunday
  ])("%s → %s", (iso, open) => {
    expect(isOpen(hours, new Date(iso))).toBe(open);
  });

  it("honours holidays and treats missing hours as always open", () => {
    expect(isOpen({ ...hours!, holidays: ["2026-09-28"] }, new Date("2026-09-28T06:00:00Z"))).toBe(false);
    expect(isOpen(undefined, new Date())).toBe(true);
  });
});
