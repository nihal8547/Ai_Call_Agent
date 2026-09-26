import argon2 from "argon2";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// OWASP-recommended argon2id parameters (19 MiB, 2 iterations)
const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Verify against a throwaway hash when the user does not exist, so a login for an unknown
 * email takes as long as one for a known email (no account enumeration by timing).
 */
export async function verifyDummyPassword(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomToken(16));
  await verifyPassword(await dummyHash, password);
  return false;
}

/** URL-safe random token (refresh tokens, invitations, API keys) */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Tokens are stored only as SHA-256 hashes */
export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
