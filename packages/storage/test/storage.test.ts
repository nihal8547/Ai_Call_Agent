import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { documentKey, LocalStorage, type ObjectStorage, S3Storage } from "../src";

async function roundTrip(storage: ObjectStorage) {
  const key = documentKey("t1", "d1", 1, "../../etc/passwd Price List (2026).pdf");
  expect(key).toBe("tenants/t1/documents/d1/v1/etc_passwd_Price_List_2026_.pdf");
  await storage.put(key, Buffer.from("hello"), "application/pdf");
  expect((await storage.get(key)).toString()).toBe("hello");
  await storage.delete(key);
  await expect(storage.get(key)).rejects.toThrow();
}

describe("LocalStorage", () => {
  it("stores, reads and deletes; rejects escaping keys", async () => {
    const storage = new LocalStorage(await mkdtemp(path.join(os.tmpdir(), "store-")));
    await roundTrip(storage);
    await expect(storage.put("../x", Buffer.from("x"), "text/plain")).rejects.toThrow(/Invalid storage key/);
  });
});

// Runs against an S3-compatible server when S3_TEST_ENDPOINT is set (e.g. moto_server or MinIO)
describe.skipIf(!process.env.S3_TEST_ENDPOINT)("S3Storage", () => {
  it("works against an S3-compatible endpoint", async () => {
    const endpoint = process.env.S3_TEST_ENDPOINT!;
    const creds = { accessKeyId: "test", secretAccessKey: "test" };
    const bucket = `docs-${Date.now()}`;
    await new S3Client({ region: "us-east-1", endpoint, forcePathStyle: true, credentials: creds }).send(
      new CreateBucketCommand({ Bucket: bucket }),
    );
    await roundTrip(new S3Storage(bucket, { region: "us-east-1", endpoint, ...creds }));
  });
});
