import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238, HMAC-SHA1, 30 s steps, 6 digits): what Google
 * Authenticator, Microsoft Authenticator, 1Password and others generate.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i === -1) throw new Error("Invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new shared secret (160 bits), base32 as authenticator apps expect */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}

export function totpCode(secretBase32: string, at: Date = new Date(), digits = DIGITS): string {
  return hotp(base32Decode(secretBase32), Math.floor(at.getTime() / 1000 / STEP_SECONDS), digits);
}

/**
 * Checks a code, allowing one step of clock drift either side. Returns the time step it matched,
 * so callers can refuse the same code twice (replay).
 */
export function verifyTotp(secretBase32: string, code: string, at: Date = new Date()): number | null {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const secret = base32Decode(secretBase32);
  const step = Math.floor(at.getTime() / 1000 / STEP_SECONDS);
  for (const s of [step, step - 1, step + 1]) {
    const expected = hotp(secret, s);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return s;
  }
  return null;
}

/** otpauth:// link for QR codes */
export function totpUri(o: { issuer: string; account: string; secret: string }): string {
  const label = encodeURIComponent(`${o.issuer}:${o.account}`);
  const q = new URLSearchParams({ secret: o.secret, issuer: o.issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${q}`;
}

/** One-time recovery codes like "7GQ4-X2MP-KT9A" (shown once; store only their hashes) */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const s = base32Encode(randomBytes(8)).slice(0, 12);
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
  });
}

export const normaliseRecoveryCode = (code: string) => code.toUpperCase().replace(/[^A-Z2-7]/g, "");
