import { MIME } from "../detect";
import { type Block, DocumentError, type Extraction, type FileKind } from "../types";
import { extractCsv, extractDocx, extractXlsx } from "./office";
import { extractPdf, splitParagraphs } from "./pdf";
import { extractText } from "./text";

/** Reads text out of images and scanned PDFs (implemented with a multimodal model) */
export interface OcrProvider {
  /** Returns the text of each page; reports the model's token usage when it knows it */
  pages(file: Buffer, mimeType: string, opts?: { onUsage?: (u: OcrUsage) => void }): Promise<string[]>;
}
export type OcrUsage = { model: string; inputTokens: number; outputTokens: number };

export async function extract(
  kind: FileKind,
  buf: Buffer,
  ocr: OcrProvider | null,
  onUsage?: (u: OcrUsage) => void,
): Promise<Extraction> {
  switch (kind) {
    case "txt":
    case "md":
      return { blocks: extractText(buf.toString("utf8"), kind === "md"), needsOcr: false };
    case "csv":
      return { blocks: extractCsv(buf.toString("utf8")), needsOcr: false };
    case "docx":
      return { blocks: await extractDocx(buf), needsOcr: false };
    case "xlsx":
      return { blocks: await extractXlsx(buf), needsOcr: false };
    case "pdf": {
      const pdf = await extractPdf(buf);
      if (!pdf.needsOcr) return { blocks: pdf.blocks, pageCount: pdf.pageCount, needsOcr: false };
      return { ...(await ocrBlocks(buf, MIME.pdf, ocr, onUsage)), pageCount: pdf.pageCount, needsOcr: true };
    }
    case "png":
    case "jpeg":
    case "webp":
      return { ...(await ocrBlocks(buf, MIME[kind], ocr, onUsage)), needsOcr: true };
  }
}

async function ocrBlocks(
  buf: Buffer,
  mime: string,
  ocr: OcrProvider | null,
  onUsage?: (u: OcrUsage) => void,
): Promise<{ blocks: Block[] }> {
  if (!ocr)
    throw new DocumentError(
      "This file is an image or a scanned document. Text recognition (OCR) needs an AI provider key to be configured.",
    );
  const pages = await ocr.pages(buf, mime, onUsage ? { onUsage } : undefined);
  const blocks = pages.flatMap((text, i) =>
    text.split("\n").some((l) => /^#{1,6}\s/.test(l))
      ? extractText(text, true).map((b) => ({ ...b, meta: { ...b.meta, page: i + 1 } }))
      : splitParagraphs(text).map((p) => ({ kind: "text" as const, text: p, meta: { page: i + 1 } })),
  );
  return { blocks };
}
