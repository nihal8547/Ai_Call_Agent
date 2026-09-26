import { z } from "zod";

/** Mirrors the database enum usage_records.kind */
export const USAGE_KINDS = [
  "TELEPHONY_MINUTES",
  "LLM_INPUT_TOKENS",
  "LLM_OUTPUT_TOKENS",
  "EMBEDDING_TOKENS",
  "TTS_CHARACTERS",
  "STT_SECONDS",
  "STORAGE_BYTES",
] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/**
 * Estimated cost per unit in micro-dollars (1 USD = 1,000,000), keyed by kind or "KIND:model".
 * These are public list prices used for estimates, not invoices: set USAGE_PRICES to your own
 * contract rates. Sources: Gemini Flash text ($0.30 / $2.50 per million tokens), Gemini
 * embeddings ($0.15 per million tokens), a typical Twilio inbound minute ($0.0085), Amazon Polly
 * neural voices ($16 per million characters), Twilio <Gather> speech recognition ($0.02 per 15 s).
 */
export const DEFAULT_PRICES: Readonly<Record<string, number>> = {
  LLM_INPUT_TOKENS: 0.3,
  LLM_OUTPUT_TOKENS: 2.5,
  EMBEDDING_TOKENS: 0.15,
  "EMBEDDING_TOKENS:hashing-384": 0,
  TELEPHONY_MINUTES: 8500,
  TTS_CHARACTERS: 16,
  STT_SECONDS: 20_000 / 15,
  STORAGE_BYTES: 0,
};

export type PriceTable = Readonly<Record<string, number>>;

const PriceOverrides = z.record(
  z.string().regex(/^[A-Z_]+(:[\w.\-/]+)?$/, "KIND or KIND:model"),
  z.number().min(0).max(10_000_000),
);

/** Merge USAGE_PRICES (JSON, micro-dollars per unit) over the defaults; invalid JSON is an error */
export function priceTable(json?: string): PriceTable {
  if (!json) return DEFAULT_PRICES;
  const parsed = PriceOverrides.safeParse(JSON.parse(json));
  if (!parsed.success) throw new Error(`USAGE_PRICES: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return { ...DEFAULT_PRICES, ...parsed.data };
}

export function unitPrice(prices: PriceTable, kind: UsageKind, model?: string | null): number {
  return (model ? prices[`${kind}:${model}`] : undefined) ?? prices[kind] ?? 0;
}

/** Estimated cost of a quantity, in whole micro-dollars */
export function costMicros(
  prices: PriceTable,
  kind: UsageKind,
  quantity: number,
  model?: string | null,
): bigint {
  return BigInt(Math.round(quantity * unitPrice(prices, kind, model)));
}

export type UsageLine = { kind: UsageKind; quantity: number; provider: string; model: string | null };

/** Add up lines of the same kind, provider and model */
export function mergeUsage(lines: UsageLine[]): UsageLine[] {
  const out = new Map<string, UsageLine>();
  for (const l of lines) {
    if (l.quantity <= 0) continue;
    const key = `${l.kind}|${l.provider}|${l.model ?? ""}`;
    const prev = out.get(key);
    out.set(key, prev ? { ...prev, quantity: prev.quantity + l.quantity } : { ...l });
  }
  return [...out.values()];
}
