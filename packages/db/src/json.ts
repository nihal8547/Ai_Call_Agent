import { type Prisma } from "@prisma/client";
import { type z } from "zod";

export class JsonColumnError extends Error {
  constructor(
    readonly column: string,
    readonly issues: z.core.$ZodIssue[],
  ) {
    super(
      `Invalid JSON in column ${column}: ${issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
    this.name = "JsonColumnError";
  }
}

/** Parse a JSONB column value read from the database. Never use raw `Json` values directly. */
export function readJson<T extends z.ZodType>(
  schema: T,
  value: Prisma.JsonValue,
  column: string,
): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new JsonColumnError(column, r.error.issues);
  return r.data;
}

/** Validate a value before writing it to a JSONB column */
export function writeJson<T extends z.ZodType>(
  schema: T,
  value: unknown,
  column: string,
): Prisma.InputJsonValue {
  const r = schema.safeParse(value);
  if (!r.success) throw new JsonColumnError(column, r.error.issues);
  return r.data as Prisma.InputJsonValue;
}
