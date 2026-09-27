import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hotp,
  totpCode,
  totpUri,
  verifyTotp,
} from "../src";

// RFC 6238 appendix B: the ASCII secret "12345678901234567890", SHA-1, 8 digits
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("TOTP", () => {
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
  ])("matches the RFC 6238 test vector at %s", (seconds, expected) => {
    expect(totpCode(RFC_SECRET, new Date(seconds * 1000), 8)).toBe(expected);
  });

  it("matches RFC 4226 HOTP values", () => {
    expect([0, 1, 2].map((c) => hotp(Buffer.from("12345678901234567890"), c))).toEqual(["755224", "287082", "359152"]);
  });

  it("accepts the current code and one step of drift, nothing else", () => {
    const secret = generateTotpSecret();
    const now = new Date("2026-09-27T10:00:10Z");
    const step = Math.floor(now.getTime() / 30_000);
    expect(verifyTotp(secret, totpCode(secret, now), now)).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, new Date(now.getTime() - 30_000)), now)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, new Date(now.getTime() + 30_000)), now)).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, new Date(now.getTime() - 90_000)), now)).toBeNull();
    expect(verifyTotp(secret, "12345", now)).toBeNull();
    expect(verifyTotp(secret, "abcdef", now)).toBeNull();
  });

  it("round-trips base32 and builds authenticator links and recovery codes", () => {
    const buf = Buffer.from([0, 1, 2, 250, 251, 255, 17]);
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
    expect(totpUri({ issuer: "Voice Agents", account: "a@b.com", secret: "ABC" })).toBe(
      "otpauth://totp/Voice%20Agents%3Aa%40b.com?secret=ABC&issuer=Voice+Agents&algorithm=SHA1&digits=6&period=30",
    );
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  });
});
