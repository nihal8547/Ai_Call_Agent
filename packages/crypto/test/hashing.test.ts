import { describe, expect, it } from "vitest";
import { hashPassword, randomToken, safeEqual, sha256Hex, verifyDummyPassword, verifyPassword } from "../src";

describe("password hashing", () => {
  it("hashes with argon2id and verifies", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    await expect(verifyPassword(hash, "correct horse battery staple")).resolves.toBe(true);
    await expect(verifyPassword(hash, "wrong")).resolves.toBe(false);
  });

  it("returns false (not throw) for malformed hashes", async () => {
    await expect(verifyPassword("not-a-hash", "x")).resolves.toBe(false);
  });
});

describe("tokens", () => {
  it("creates url-safe random tokens and stable hashes", () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "ab")).toBe(false);
  });
});

describe("verifyDummyPassword", () => {
  it("always returns false", async () => {
    await expect(verifyDummyPassword("anything")).resolves.toBe(false);
  });
});
