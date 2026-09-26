import ExcelJS from "exceljs";
import mammoth from "mammoth";
import Papa from "papaparse";
import { type Block, DocumentError } from "../types";
import { rowsToRecords } from "./tables";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};
const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(
      /&(#\d+|#x[0-9a-f]+|\w+);/gi,
      (m, e: string) =>
        ENTITIES[e] ??
        (e.startsWith("#x")
          ? String.fromCodePoint(parseInt(e.slice(2), 16))
          : e.startsWith("#")
            ? String.fromCodePoint(Number(e.slice(1)))
            : m),
    )
    .replace(/\s+/g, " ")
    .trim();

/** Word: headings, paragraphs, list items and tables, in document order */
export async function extractDocx(buf: Buffer): Promise<Block[]> {
  let html: string;
  try {
    html = (await mammoth.convertToHtml({ buffer: buf })).value;
  } catch {
    throw new DocumentError("This Word file could not be read. Is it corrupted or password-protected?");
  }
  const blocks: Block[] = [];
  const re = /<(h[1-6]|p|li|table)[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const m of html.matchAll(re)) {
    const tag = m[1]!.toLowerCase();
    if (tag === "table") {
      const rows = [...m[2]!.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
        [...r[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => decode(c[1]!)),
      );
      blocks.push(...rowsToRecords(rows, {}));
      continue;
    }
    const text = decode(m[2]!);
    if (!text) continue;
    if (tag.startsWith("h")) blocks.push({ kind: "heading", text, level: Number(tag[1]), meta: {} });
    else blocks.push({ kind: "text", text: tag === "li" ? `• ${text}` : text, meta: {} });
  }
  return blocks;
}

/** Excel: every sheet, every row as a record carrying its header names */
export async function extractXlsx(buf: Buffer): Promise<Block[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new DocumentError("This Excel file could not be read. Is it corrupted or password-protected?");
  }
  const blocks: Block[] = [];
  wb.eachSheet((sheet) => {
    const rows: unknown[][] = [];
    sheet.eachRow({ includeEmpty: true }, (row, n) => {
      rows[n - 1] = (row.values as unknown[]).slice(1);
    });
    blocks.push({ kind: "heading", text: sheet.name, level: 1, meta: { sheet: sheet.name } });
    blocks.push(
      ...rowsToRecords(
        Array.from(rows, (r) => r ?? []),
        { sheet: sheet.name },
      ),
    );
  });
  return blocks;
}

export function extractCsv(content: string): Block[] {
  const parsed = Papa.parse<string[]>(content.replace(/^\uFEFF/, ""), { skipEmptyLines: true });
  return rowsToRecords(parsed.data, {});
}
