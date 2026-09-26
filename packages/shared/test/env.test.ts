import { describe, expect, it } from "vitest";
import { z } from "zod";
import { envPrimitives, parseEnv } from "../src";

describe("parseEnv", () => {
  const schema = z.object({
    PORT: envPrimitives.port,
    DATABASE_URL: envPrimitives.postgresUrl,
    ORIGINS: envPrimitives.csv,
  });

  it("parses and coerces valid values", () => {
    const env = parseEnv(schema, { PORT: "4000", DATABASE_URL: "postgresql://u@h/db", ORIGINS: "a, b,," });
    expect(env).toEqual({ PORT: 4000, DATABASE_URL: "postgresql://u@h/db", ORIGINS: ["a", "b"] });
  });

  it("lists every invalid variable", () => {
    expect(() => parseEnv(schema, { PORT: "0", DATABASE_URL: "mysql://x" })).toThrowError(
      /PORT[\s\S]*DATABASE_URL/,
    );
  });

  it("treats empty values as unset", () => {
    const opt = z.object({ KEY: z.string().min(10).optional(), PORT: envPrimitives.port.default(4000) });
    expect(parseEnv(opt, { KEY: "", PORT: "" })).toEqual({ PORT: 4000 });
  });

  it("validates 32-byte base64 keys", () => {
    const key = z.object({ K: envPrimitives.key32 });
    expect(() => parseEnv(key, { K: Buffer.alloc(16).toString("base64") })).toThrow(/32 bytes/);
    expect(parseEnv(key, { K: Buffer.alloc(32).toString("base64") }).K).toHaveLength(44);
  });
});
