import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope encryption.
 *
 *   master key (env / KMS) ──encrypts──► per-tenant data key (DEK, stored in tenants.encrypted_dek)
 *   DEK ──encrypts──► secrets (integration credentials, TOTP secrets, …)
 *
 * Ciphertext format (versioned so keys/algorithms can rotate):
 *   [1 byte version=1][12 byte IV][16 byte GCM tag][ciphertext]
 *
 * `aad` (additional authenticated data) binds a ciphertext to its context, e.g. the tenant id,
 * so a value copied into another tenant's row fails to decrypt.
 */
const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const HEADER_LEN = 1 + IV_LEN + TAG_LEN;

export class DecryptionError extends Error {
  constructor(message = "Unable to decrypt value") {
    super(message);
    this.name = "DecryptionError";
  }
}

function assertKey(key: Buffer, name: string): void {
  if (key.length !== KEY_LEN) throw new Error(`${name} must be ${KEY_LEN} bytes`);
}

export function encrypt(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  assertKey(key, "key");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decrypt(key: Buffer, payload: Buffer, aad: string): Buffer {
  assertKey(key, "key");
  if (payload.length < HEADER_LEN || payload[0] !== VERSION)
    throw new DecryptionError("Unsupported ciphertext");
  const iv = payload.subarray(1, 1 + IV_LEN);
  const tag = payload.subarray(1 + IV_LEN, HEADER_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(payload.subarray(HEADER_LEN)), decipher.final()]);
  } catch {
    throw new DecryptionError();
  }
}

/** Create a new random DEK and return it together with its master-key-encrypted form */
export function generateDataKey(masterKey: Buffer, tenantId: string): { dek: Buffer; encryptedDek: Buffer } {
  const dek = randomBytes(KEY_LEN);
  return { dek, encryptedDek: encrypt(masterKey, dek, `dek:${tenantId}`) };
}

export function unwrapDataKey(masterKey: Buffer, encryptedDek: Buffer, tenantId: string): Buffer {
  return decrypt(masterKey, encryptedDek, `dek:${tenantId}`);
}

/** Encrypt a JSON-serialisable secret with a tenant DEK */
export function sealJson(dek: Buffer, value: unknown, aad: string): Buffer {
  return encrypt(dek, Buffer.from(JSON.stringify(value), "utf8"), aad);
}

export function openJson<T = unknown>(dek: Buffer, payload: Buffer, aad: string): T {
  return JSON.parse(decrypt(dek, payload, aad).toString("utf8")) as T;
}

export function parseMasterKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  assertKey(key, "master key");
  return key;
}
