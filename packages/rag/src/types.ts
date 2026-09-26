export type FileKind = "pdf" | "docx" | "xlsx" | "csv" | "txt" | "md" | "png" | "jpeg" | "webp";

export type BlockMeta = { page?: number; headingPath?: string[]; sheet?: string; row?: number };

/**
 * A unit of extracted content in reading order.
 * - heading: sets the section for following blocks
 * - text: a paragraph that may be split between chunks
 * - record: a table row / spreadsheet row, never split
 */
export type Block = { kind: "heading" | "text" | "record"; text: string; level?: number; meta: BlockMeta };

export type Extraction = { blocks: Block[]; pageCount?: number; needsOcr: boolean };

export type Chunk = {
  content: string;
  tokenCount: number;
  metadata: BlockMeta & { pages?: number[]; rows?: [number, number] };
};

/** Thrown for problems the user must fix (unsupported/empty/corrupt file); never retried */
export class DocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentError";
  }
}
