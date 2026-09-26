import type { Block } from "../types";

/** Plain text and Markdown: blank lines separate paragraphs; "#" lines are headings */
export function extractText(content: string, markdown: boolean): Block[] {
  const blocks: Block[] = [];
  for (const para of content.replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    const lines = para.split("\n");
    let buffer: string[] = [];
    const flush = () => {
      const text = buffer.join(" ").trim();
      if (text) blocks.push({ kind: "text", text, meta: {} });
      buffer = [];
    };
    for (const line of lines) {
      const h = markdown ? /^(#{1,6})\s+(.*)$/.exec(line.trim()) : null;
      if (h) {
        flush();
        blocks.push({ kind: "heading", text: h[2]!.trim(), level: h[1]!.length, meta: {} });
      } else {
        buffer.push(markdown ? line.replace(/^\s*[-*+]\s+/, "• ").replace(/[*_`]/g, "") : line);
      }
    }
    flush();
  }
  return blocks;
}
