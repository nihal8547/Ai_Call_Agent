import { extractText, getDocumentProxy } from "unpdf";
import { type Block, DocumentError } from "../types";

/**
 * Text PDFs: one block per paragraph, tagged with its page.
 * Returns needsOcr when pages carry (almost) no text — a scanned document.
 */
export async function extractPdf(
  buf: Buffer,
): Promise<{ blocks: Block[]; pageCount: number; needsOcr: boolean }> {
  let pages: string[];
  let pageCount: number;
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const out = await extractText(pdf, { mergePages: false });
    pages = out.text as string[];
    pageCount = out.totalPages;
  } catch {
    throw new DocumentError("This PDF could not be read. Is it corrupted or password-protected?");
  }
  const chars = pages.reduce((n, p) => n + p.replace(/\s/g, "").length, 0);
  if (pageCount > 0 && chars / pageCount < 20) return { blocks: [], pageCount, needsOcr: true };

  // Running headers/footers repeat on most pages; drop them line by line before building paragraphs
  const pageLines = pages.map((p) =>
    p
      .replace(/\r/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const norm = (l: string) => l.toLowerCase().replace(/\d+/g, "#");
  const seenOn = new Map<string, number>();
  for (const lines of pageLines)
    for (const l of new Set(lines.filter((x) => x.length <= 100).map(norm)))
      seenOn.set(l, (seenOn.get(l) ?? 0) + 1);
  const repeated = new Set(
    [...seenOn].filter(([, n]) => pageCount >= 3 && n >= Math.max(3, pageCount * 0.6)).map(([l]) => l),
  );

  const blocks: Block[] = [];
  pageLines.forEach((lines, i) => {
    const kept = lines.filter((l) => !repeated.has(norm(l)) && !PAGE_NUMBER.test(l));
    let buffer: string[] = [];
    const flush = () => {
      for (const para of splitParagraphs(buffer.join("\n")))
        blocks.push({ kind: "text", text: para, meta: { page: i + 1 } });
      buffer = [];
    };
    kept.forEach((line, j) => {
      if (isHeadingLine(line, kept[j + 1])) {
        flush();
        blocks.push({ kind: "heading", text: line, level: 2, meta: { page: i + 1 } });
      } else buffer.push(line);
    });
    flush();
  });
  return { blocks, pageCount, needsOcr: false };
}

const PAGE_NUMBER = /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i;

/** Short title-like line followed by body text: "Our services", "Pricing" */
function isHeadingLine(line: string, next: string | undefined): boolean {
  if (!next || line.length > 60 || /[.,;:!?)]$/.test(line) || !/^[A-Z0-9]/.test(line)) return false;
  const words = line.split(/\s+/).length;
  return words <= 6 && next.length > line.length;
}

/** pdf.js text has line breaks but rarely blank lines; rebuild paragraphs from line shapes */
export function splitParagraphs(pageText: string): string[] {
  const lines = pageText
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim());
  const paras: string[] = [];
  let cur = "";
  for (const line of lines) {
    if (!line) {
      if (cur) paras.push(cur);
      cur = "";
      continue;
    }
    const endsSentence = /[.!?:]$/.test(cur);
    const looksLikeNew = /^([•\-–*]|\d+[.)]\s|[A-Z][A-Z ]{3,}$)/.test(line);
    if (cur && (endsSentence && /^[A-Z0-9•]/.test(line) ? cur.length > 300 || looksLikeNew : looksLikeNew)) {
      paras.push(cur);
      cur = line;
    } else cur = cur ? `${cur} ${line}` : line;
  }
  if (cur) paras.push(cur);
  return paras.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
}
