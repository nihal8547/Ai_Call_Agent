import { describe, expect, it } from "vitest";
import { AGENT_LANGUAGES, voiceForLanguage, voicesFor } from "../src";

describe("agent languages and voices", () => {
  it("offers Arabic voices for every Arabic language", () => {
    for (const l of AGENT_LANGUAGES.filter((x) => x.code.startsWith("ar")))
      expect(voicesFor(l.code).map((v) => v.id)).toContain("Polly.Hala-Neural");
    expect(voicesFor("en-US").map((v) => v.id)).not.toContain("Polly.Hala-Neural");
  });

  it("keeps a voice that fits, replaces one that doesn't, and leaves unknown voices alone", () => {
    expect(voiceForLanguage("ar-QA", "Polly.Zayd-Neural")).toBe("Polly.Zayd-Neural");
    expect(voiceForLanguage("ar-QA", "Polly.Kajal-Neural")).toBe("Polly.Hala-Neural");
    expect(voiceForLanguage("en-GB", "Polly.Hala-Neural")).toBe("Polly.Amy-Neural");
    expect(voiceForLanguage("ar-QA", "Google.ar-XA-Standard-A")).toBe("Google.ar-XA-Standard-A");
  });
});
