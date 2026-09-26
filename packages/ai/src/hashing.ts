import type { EmbeddingProvider, EmbeddingResult } from "./types";

/**
 * Deterministic lexical embeddings (feature hashing of word unigrams and bigrams), no network.
 * For development and tests only: similarity reflects shared words, not meaning.
 */
export class HashingEmbeddings implements EmbeddingProvider {
  readonly name = "hashing";
  readonly model = "hashing-v1";

  constructor(readonly dimensions = 768) {}

  async embed(texts: string[]): Promise<EmbeddingResult> {
    return {
      ok: true,
      vectors: texts.map((t) => this.vector(t)),
      usage: { inputTokens: 0 },
      model: this.model,
    };
  }

  private vector(text: string): number[] {
    const v = new Array<number>(this.dimensions).fill(0);
    const words =
      text
        .toLowerCase()
        .normalize("NFKD")
        .match(/[\p{L}\p{N}]+/gu) ?? [];
    const stems = words.filter((w) => w.length > 2).map((w) => (w.length > 4 ? w.replace(/(es|s)$/, "") : w));
    const features = [...stems, ...stems.slice(1).map((w, i) => `${stems[i]}_${w}`)];
    for (const f of features) {
      const h = fnv1a(f);
      v[h % this.dimensions]! += (h >>> 31) & 1 ? -1 : 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
