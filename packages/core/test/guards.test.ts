import { describe, expect, it } from "vitest";
import { guardOutput, redactDeep, redactPII, unsupportedNumbers } from "../src";

describe("guardOutput", () => {
  it("passes normal speech", () => {
    expect(guardOutput("  Sure,  we are open until 7 PM. ")).toEqual({
      ok: true,
      text: "Sure, we are open until 7 PM.",
    });
  });

  it.each([
    ["Error: connection refused", "technical_error"],
    ["The API key is invalid", "technical_error"],
    ['{"intent": "answer"}', "markup"],
    ["**Great!** here you go", "markup"],
    ["use sk-abcdefghijklmnop123", "secret"],
    ["visit https://example.com", "url"],
    ["", "empty"],
  ])("blocks %j (%s)", (text, violation) => {
    const r = guardOutput(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations).toContain(violation);
  });

  it("trims long answers at a sentence boundary, rejects unbroken walls of text", () => {
    const long = `${"We offer many services. ".repeat(30)}`;
    const r = guardOutput(long, { maxChars: 120 });
    expect(r.ok && r.text.endsWith(".") && r.text.length <= 120).toBe(true);
    expect(guardOutput("a".repeat(500), { maxChars: 100 })).toEqual({ ok: false, violations: ["too_long"] });
  });

  it("flags numbers that are not in the sources", () => {
    const sources = ["Consultation fee is ₹500. Implants start at 25,000 rupees. Open 9 to 7."];
    expect(unsupportedNumbers("Consultation is 500 rupees and implants start at 25000.", sources)).toEqual(
      [],
    );
    expect(unsupportedNumbers("Implants cost 15000 and we open at 9.", sources)).toEqual(["15000"]);
  });
});

describe("redactPII", () => {
  it("redacts contact details and identifiers", () => {
    expect(redactPII("call me on +91 98765 43210 or 9876543210")).toBe("call me on [PHONE] or [PHONE]");
    expect(redactPII("mail asha@example.com")).toBe("mail [EMAIL]");
    expect(redactPII("card 4111 1111 1111 1111 please")).toBe("card [CARD] please");
    expect(redactPII("aadhaar 1234 5678 9012")).toBe("aadhaar [AADHAAR]");
    expect(redactPII("PAN ABCDE1234F")).toBe("PAN [PAN]");
  });

  it("keeps ordinary numbers", () => {
    expect(redactPII("budget 80 lakh for 3 bedrooms at 5 pm on 12/10")).toBe(
      "budget 80 lakh for 3 bedrooms at 5 pm on 12/10",
    );
  });

  it("redacts nested payloads", () => {
    expect(redactDeep({ turn: { text: "I'm at asha@example.com" }, n: 3 })).toEqual({
      turn: { text: "I'm at [EMAIL]" },
      n: 3,
    });
  });
});
