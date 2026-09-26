/**
 * Latency is rolled up as histograms (counts per bucket) so hours and days can be merged and
 * percentiles read back approximately — exact percentiles cannot be added up.
 */
export const LATENCY_HOPS = ["turn", "understand", "search", "answer", "tool", "phrase"] as const;
export type LatencyHop = (typeof LATENCY_HOPS)[number];

/** Upper bounds in ms; bucket i is [bound[i-1], bound[i]), the last bucket is open-ended */
export const LATENCY_BOUNDS_MS = [100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000] as const;
export const LATENCY_BUCKETS = LATENCY_BOUNDS_MS.length + 1;

export function latencyBucket(ms: number): number {
  const i = LATENCY_BOUNDS_MS.findIndex((b) => ms < b);
  return i === -1 ? LATENCY_BOUNDS_MS.length : i;
}

export function mergeHistograms(
  a: readonly number[] | undefined,
  b: readonly number[] | undefined,
): number[] {
  return Array.from({ length: LATENCY_BUCKETS }, (_, i) => (a?.[i] ?? 0) + (b?.[i] ?? 0));
}

/**
 * Approximate percentile (0–100) by linear interpolation inside the bucket it falls in.
 * Values in the open-ended last bucket are reported as its lower bound (i.e. "≥ 5 s").
 */
export function histogramPercentile(h: readonly number[], p: number): number | null {
  const total = h.reduce((n, c) => n + c, 0);
  if (!total) return null;
  const rank = (p / 100) * total;
  let seen = 0;
  for (let i = 0; i < LATENCY_BUCKETS; i++) {
    const count = h[i] ?? 0;
    if (count && seen + count >= rank) {
      const lower = i === 0 ? 0 : LATENCY_BOUNDS_MS[i - 1]!;
      if (i === LATENCY_BOUNDS_MS.length) return lower;
      const upper = LATENCY_BOUNDS_MS[i]!;
      return Math.round(lower + ((rank - seen) / count) * (upper - lower));
    }
    seen += count;
  }
  return LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1]!;
}

/** Tool errors that are normal conversation outcomes (a taken slot), not failures */
export const TOOL_BUSINESS_OUTCOMES = [
  "slot_unavailable",
  "closed",
  "too_soon",
  "too_far",
  "in_the_past",
  "no_slots",
  "no_appointment",
] as const;
