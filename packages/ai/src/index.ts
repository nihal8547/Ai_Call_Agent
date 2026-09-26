export * from "./gemini";
export * from "./scripted";
export * from "./types";

import { GeminiProvider } from "./gemini";
import type { LLMProvider } from "./types";

/** Build the provider an agent is configured for; null when no key is available (fallback-only calls) */
export function createLLMProvider(
  provider: "gemini" | "openai" | "anthropic",
  keys: { gemini?: string },
): LLMProvider | null {
  switch (provider) {
    case "gemini":
      return keys.gemini ? new GeminiProvider(keys.gemini) : null;
    default:
      // OpenAI and Anthropic adapters arrive in P14; agents configured for them run on deterministic fallbacks
      return null;
  }
}
export * from "./hashing";
export * from "./ocr";

import { GeminiEmbeddings } from "./gemini";
import { HashingEmbeddings } from "./hashing";
import type { EmbeddingProvider } from "./types";

/**
 * The same choice must be made by every process (worker for documents, API for queries):
 * vectors from different models are not comparable.
 * auto = Gemini when a key is present, otherwise none (keyword search only).
 */
export function createEmbeddingProvider(
  provider: "auto" | "gemini" | "hashing" | "none",
  keys: { gemini?: string },
): EmbeddingProvider | null {
  if (provider === "hashing") return new HashingEmbeddings();
  if (provider === "none") return null;
  if (keys.gemini) return new GeminiEmbeddings(keys.gemini);
  if (provider === "gemini") throw new Error("EMBEDDINGS_PROVIDER=gemini requires GEMINI_API_KEY");
  return null;
}
