import { z } from "zod";

/**
 * Parse process.env (or any record) with a zod schema and fail fast with a readable
 * message listing every invalid variable. Apps call this once at startup.
 */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  return result.data;
}

/** Building blocks reused by every app's env schema */
export const envPrimitives = {
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  port: z.coerce.number().int().min(1).max(65535),
  url: z.url(),
  postgresUrl: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// or postgresql:// URL"),
  redisUrl: z.string().regex(/^rediss?:\/\//, "must be a redis:// or rediss:// URL"),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Comma-separated list → string[] */
  csv: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  /** 32-byte key as base64 */
  key32: z
    .string()
    .refine((s) => Buffer.from(s, "base64").length === 32, "must be 32 bytes encoded as base64"),
};
