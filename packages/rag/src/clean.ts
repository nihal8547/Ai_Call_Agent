import type { Block } from "./types";

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

const PAGE_NUMBER = /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i;

/**
 * Remove noise that hurts retrieval: page numbers, running headers/footers repeated on most pages,
 * duplicate consecutive blocks, stray whitespace.
 */
export function cleanBlocks(blocks: Block[]): Block[] {
  const pages = new Set(blocks.map((b) => b.meta.page).filter((p) => p !== undefined));
  const repeated = new Set<string>();
  if (pages.size >= 3) {
    const seenOn = new Map<string, Set<number>>();
    for (const b of blocks) {
      if (b.meta.page === undefined || b.text.length > 100) continue;
      const key = b.text.toLowerCase().replace(/\d+/g, "#");
      (seenOn.get(key) ?? seenOn.set(key, new Set()).get(key)!).add(b.meta.page);
    }
    for (const [key, onPages] of seenOn) if (onPages.size >= Math.max(3, pages.size * 0.6)) repeated.add(key);
  }

  const out: Block[] = [];
  for (const b of blocks) {
    const text = b.text.replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim();
    if (!text || PAGE_NUMBER.test(text)) continue;
    if (repeated.has(text.toLowerCase().replace(/\d+/g, "#"))) continue;
    const prev = out[out.length - 1];
    if (prev && prev.text === text && prev.kind === b.kind) continue;
    out.push({ ...b, text });
  }
  return out;
}
