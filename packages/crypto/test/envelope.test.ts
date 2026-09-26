import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DecryptionError,
  decrypt,
  encrypt,
  generateDataKey,
  openJson,
  parseMasterKey,
  sealJson,
  unwrapDataKey,
} from "../src";

const master = randomBytes(32);
const tenantA = "00000000-0000-7000-8000-00000000000a";
const tenantB = "00000000-0000-7000-8000-00000000000b";

describe("envelope encryption", () => {
  it("round-trips a value", () => {
    const key = randomBytes(32);
    const ct = encrypt(key, Buffer.from("hello"), "ctx");
    expect(decrypt(key, ct, "ctx").toString()).toBe("hello");
  });

  it("uses a fresh IV every time", () => {
    const key = randomBytes(32);
    expect(encrypt(key, Buffer.from("x"), "a").equals(encrypt(key, Buffer.from("x"), "a"))).toBe(false);
  });

  it("rejects a wrong AAD, wrong key or tampered ciphertext", () => {
    const key = randomBytes(32);
    const ct = encrypt(key, Buffer.from("secret"), "tenant:a");
    expect(() => decrypt(key, ct, "tenant:b")).toThrow(DecryptionError);
    expect(() => decrypt(randomBytes(32), ct, "tenant:a")).toThrow(DecryptionError);
    const tampered = Buffer.from(ct);
    tampered[tampered.length - 1]! ^= 0xff;
    expect(() => decrypt(key, tampered, "tenant:a")).toThrow(DecryptionError);
  });

  it("wraps DEKs per tenant", () => {
    const { dek, encryptedDek } = generateDataKey(master, tenantA);
    expect(unwrapDataKey(master, encryptedDek, tenantA).equals(dek)).toBe(true);
    expect(() => unwrapDataKey(master, encryptedDek, tenantB)).toThrow(DecryptionError);
  });

  it("seals JSON secrets", () => {
    const { dek } = generateDataKey(master, tenantA);
    const sealed = sealJson(dek, { apiKey: "sk_123" }, "integration:1");
    expect(sealed.toString("utf8")).not.toContain("sk_123");
    expect(openJson(dek, sealed, "integration:1")).toEqual({ apiKey: "sk_123" });
  });

  it("validates master key length", () => {
    expect(() => parseMasterKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
    expect(parseMasterKey(master.toString("base64")).equals(master)).toBe(true);
  });
});
