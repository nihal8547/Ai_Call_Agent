import { describe, expect, it } from "vitest";
import { contentWords } from "../src";

describe("keyword search words", () => {
  it("keeps what an Arabic question is about, not its question words", () => {
    expect(contentWords("كم سعر الشقة في لوسيل؟")).toEqual(["سعر", "الشقة", "لوسيل"]);
    expect(contentWords("لو سمحت، هل عندكم مواقف للسيارات")).toEqual(["مواقف", "للسيارات"]);
  });
});
