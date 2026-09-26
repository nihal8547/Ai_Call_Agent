import { describe, expect, it } from "vitest";
import { processSystemJob } from "../src/processors/system";

describe("system queue", () => {
  it("processes a noop job", async () => {
    await expect(processSystemJob({ id: "1", data: { type: "noop" } })).resolves.toEqual({
      ok: true,
      type: "noop",
    });
  });

  it("rejects an invalid payload", async () => {
    await expect(processSystemJob({ id: "2", data: { type: "drop_tables" } })).rejects.toThrow();
  });
});
