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
