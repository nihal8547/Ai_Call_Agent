import { describe, expect, it } from "vitest";
import { diffJson } from "../src";

describe("diffJson", () => {
  it("reports nested changes as paths", () => {
    expect(diffJson({ a: 1, b: { c: "x" } }, { a: 1, b: { c: "y" }, d: true })).toEqual([
      { path: "b.c", kind: "changed", before: "x", after: "y" },
      { path: "d", kind: "added", after: true },
    ]);
  });

  it("matches keyed arrays by identity and reports reordering once", () => {
    const before = [
      { key: "name", q: "Name?" },
      { key: "budget", q: "Budget?" },
    ];
    const after = [
      { key: "budget", q: "Your budget?" },
      { key: "name", q: "Name?" },
      { key: "city", q: "City?" },
    ];
    expect(diffJson({ fields: before }, { fields: after })).toEqual([
      { path: "fields.budget.q", kind: "changed", before: "Budget?", after: "Your budget?" },
      { path: "fields.city", kind: "added", after: { key: "city", q: "City?" } },
      { path: "fields.order", kind: "changed", before: ["name", "budget"], after: ["budget", "name"] },
    ]);
  });

  it("returns nothing for equal values", () => {
    expect(diffJson({ x: [1, 2] }, { x: [1, 2] })).toEqual([]);
  });
});
