import type { Block, Chunk } from "./types";

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export type ChunkOptions = { targetTokens?: number; maxTokens?: number; overlapTokens?: number };

/**
 * Pack blocks into retrieval chunks of roughly `targetTokens`.
 * - Each chunk starts with its section path ("Pricing > Implants") so it stands alone.
 * - Records (table rows) are never split; long paragraphs split at sentence boundaries.
 * - Consecutive chunks in the same section overlap by a sentence or two.
 * - A new section (heading, sheet) always starts a new chunk.
 */
export function chunkBlocks(blocks: Block[], opts: ChunkOptions = {}): Chunk[] {
  const target = opts.targetTokens ?? 400;
  const max = opts.maxTokens ?? 600;
  const overlap = opts.overlapTokens ?? 60;

  const chunks: Chunk[] = [];
  const stack: { level: number; text: string }[] = [];
  const headings: string[] = [];
  let parts: { text: string; block: Block }[] = [];
  let section = "";

  const flush = (carryOverlap: boolean) => {
    if (!parts.length) return;
    const body = parts.map((p) => p.text).join("\n");
    const content = section ? `${section}\n${body}` : body;
    const pages = [
      ...new Set(parts.map((p) => p.block.meta.page).filter((x): x is number => x !== undefined)),
    ];
    const rows = parts.map((p) => p.block.meta.row).filter((x): x is number => x !== undefined);
    const first = parts[0]!.block.meta;
    chunks.push({
      content,
      tokenCount: estimateTokens(content),
      metadata: {
        ...(first.page !== undefined ? { page: first.page } : {}),
        ...(pages.length > 1 ? { pages } : {}),
        ...(headings.length ? { headingPath: [...headings] } : {}),
        ...(first.sheet ? { sheet: first.sheet } : {}),
        ...(rows.length ? { rows: [Math.min(...rows), Math.max(...rows)] as [number, number] } : {}),
      },
    });
    const last = parts[parts.length - 1]!;
    parts =
      carryOverlap && last.block.kind === "text"
        ? [{ text: tail(last.text, overlap), block: last.block }]
        : [];
  };

  const size = () => estimateTokens(parts.map((p) => p.text).join("\n") + section);

  for (const block of blocks) {
    if (block.kind === "heading") {
      flush(false);
      // A heading closes every open section at the same or a deeper level
      const level = block.level ?? 1;
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, text: block.text });
      headings.splice(0, headings.length, ...stack.map((h) => h.text));
      section = headings.join(" > ");
      continue;
    }
    const pieces =
      block.kind === "record" || estimateTokens(block.text) <= max
        ? [block.text]
        : splitSentences(block.text, target);
    for (const text of pieces) {
      if (parts.length && size() + estimateTokens(text) > target) flush(true);
      parts.push({ text, block });
      if (size() > max) flush(false);
    }
  }
  flush(false);
  // Drop chunks that are only an overlap tail
  return chunks.filter((c, i) => i === 0 || c.content !== chunks[i - 1]!.content);
}

function splitSentences(text: string, targetTokens: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && estimateTokens(cur + s) > targetTokens) {
      out.push(cur.trim());
      cur = "";
    }
    // A single enormous "sentence" (no punctuation) is cut by length
    if (estimateTokens(s) > targetTokens * 1.5) {
      for (let i = 0; i < s.length; i += targetTokens * 4) out.push(s.slice(i, i + targetTokens * 4).trim());
      continue;
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The last sentence(s) of a paragraph, up to about `tokens` */
function tail(text: string, tokens: number): string {
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [text];
  let out = "";
  for (let i = sentences.length - 1; i >= 0; i--) {
    if (estimateTokens(sentences[i]! + out) > tokens && out) break;
    out = sentences[i]! + out;
  }
  return out.trim().slice(-tokens * 4);
}
