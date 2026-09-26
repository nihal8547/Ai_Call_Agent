export type Change = {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Structural diff of two JSON values, reported as dotted paths ("qualificationFields.2.question").
 * Arrays of objects with a `key` or `id` are matched by that identity, so reordering or inserting
 * a question does not show every later question as changed.
 */
export function diffJson(before: unknown, after: unknown, path = ""): Change[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const at = (k: string | number) => (path ? `${path}.${k}` : String(k));

  if (Array.isArray(before) && Array.isArray(after)) {
    const idOf = (v: unknown) => (isObject(v) ? ((v.key ?? v.id) as string | undefined) : undefined);
    const keyed = [...before, ...after].every((v) => typeof idOf(v) === "string");
    if (keyed) {
      const changes: Change[] = [];
      const b = new Map(before.map((v) => [idOf(v)!, v]));
      const a = new Map(after.map((v) => [idOf(v)!, v]));
      for (const [id, v] of b) if (!a.has(id)) changes.push({ path: at(id), kind: "removed", before: v });
      for (const [id, v] of a) {
        if (!b.has(id)) changes.push({ path: at(id), kind: "added", after: v });
        else changes.push(...diffJson(b.get(id), v, at(id)));
      }
      const orderB = before.map(idOf).filter((id) => a.has(id!));
      const orderA = after.map(idOf).filter((id) => b.has(id!));
      if (orderB.join() !== orderA.join())
        changes.push({ path: at("order"), kind: "changed", before: orderB, after: orderA });
      return changes;
    }
    return [{ path: path || "(root)", kind: "changed", before, after }];
  }
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((k) => {
      if (!(k in before)) return [{ path: at(k), kind: "added" as const, after: after[k] }];
      if (!(k in after)) return [{ path: at(k), kind: "removed" as const, before: before[k] }];
      return diffJson(before[k], after[k], at(k));
    });
  }
  return [{ path: path || "(root)", kind: "changed", before, after }];
}
