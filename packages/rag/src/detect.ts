import type { FileKind } from "./types";

export const MIME: Record<FileKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

const startsWith = (buf: Buffer, bytes: number[], offset = 0) => bytes.every((b, i) => buf[offset + i] === b);

/**
 * Identify a file from its bytes (magic numbers), not from the name or the browser's claim.
 * Office files are ZIPs: the entry names in the archive tell Word from Excel.
 */
export function detectFileKind(buf: Buffer, fileName: string): FileKind | null {
  if (buf.length === 0) return null;
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46])) return "pdf"; // %PDF
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47])) return "png";
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8))
    return "webp";
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    const names = buf.toString("latin1");
    if (names.includes("word/document.xml")) return "docx";
    if (names.includes("xl/workbook.xml")) return "xlsx";
    return null;
  }
  // Text: valid UTF-8 without NUL bytes
  const sample = buf.subarray(0, 64 * 1024);
  if (sample.includes(0)) return null;
  if (!isUtf8(sample)) return null;
  const ext = fileName.toLowerCase().split(".").pop();
  if (ext === "csv") return "csv";
  if (ext === "md" || ext === "markdown") return "md";
  return "txt";
}

function isUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf.length === 64 * 1024 ? trimPartial(buf) : buf);
    return true;
  } catch {
    return false;
  }
}

/** A 64 KiB sample may end mid-character; drop a trailing partial sequence */
function trimPartial(buf: Buffer): Buffer {
  const end = buf.length;
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const b = buf[end - i]!;
    if ((b & 0xc0) === 0xc0) return buf.subarray(0, end - i);
    if ((b & 0x80) === 0) break;
  }
  return buf;
}
