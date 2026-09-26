import type { Block } from "../types";

/**
 * Rows become self-contained records ("Plan: Gold; Price: 4999; Validity: 1 year") so a retrieved
 * row makes sense on its own without the header row.
 */
export function rowsToRecords(rows: unknown[][], meta: { sheet?: string }): Block[] {
  const cells = rows.map((r) => r.map(cellText));
  const headerIndex = cells.findIndex((r) => r.filter(Boolean).length >= 2);
  if (headerIndex === -1) {
    return cells
      .filter((r) => r.some(Boolean))
      .map((r, i) => ({
        kind: "record" as const,
        text: r.filter(Boolean).join("; "),
        meta: { ...meta, row: i + 1 },
      }));
  }
  const header = cells[headerIndex]!.map((h, i) => h || `Column ${i + 1}`);
  const out: Block[] = [];
  for (let i = headerIndex + 1; i < cells.length; i++) {
    const row = cells[i]!;
    const pairs = row.map((v, c) => (v ? `${header[c] ?? `Column ${c + 1}`}: ${v}` : "")).filter(Boolean);
    if (pairs.length) out.push({ kind: "record", text: pairs.join("; "), meta: { ...meta, row: i + 1 } });
  }
  return out;
}

export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { richText?: { text: string }[]; result?: unknown; text?: string; hyperlink?: string };
    if (o.richText)
      return o.richText
        .map((r) => r.text)
        .join("")
        .trim();
    if (o.result !== undefined) return cellText(o.result);
    if (o.text !== undefined) return String(o.text).trim();
    return "";
  }
  return String(v).replace(/\s+/g, " ").trim();
}
