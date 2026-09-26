import { normalizeUtterance } from "./text";

const SYNONYMS: Record<string, string[]> = {
  apartment: ["flat", "apartment", "2bhk", "3bhk", "1bhk", "bhk"],
  "own funds": ["own funds", "cash", "self funded", "my own money", "savings", "full payment"],
  "bank loan": ["loan", "home loan", "bank", "mortgage", "finance from bank"],
  "need assistance": ["help", "assistance", "not sure", "don't know", "guide"],
  immediately: ["immediately", "right away", "asap", "now", "urgent", "this month"],
  emergency: ["emergency", "urgent", "severe pain", "bleeding", "swelling", "right now"],
  flexible: ["flexible", "any time", "anytime", "whenever", "no rush"],
  "just exploring": ["exploring", "just looking", "browsing", "not sure yet", "no plan"],
  none: ["none", "no occasion", "nothing special", "no"],
};

/**
 * Match free speech to one configured option: exact/contains match first, then synonyms,
 * then word overlap. Returns the option exactly as configured.
 */
export function matchOption(input: string, options: readonly string[]): string | undefined {
  const text = ` ${normalizeUtterance(input)
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")} `;
  const norm = (o: string) =>
    o
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  // 1. an option mentioned verbatim (longest first, so "3 to 6 months" beats "months")
  const byLength = [...options].sort((a, b) => norm(b).length - norm(a).length);
  const exact = byLength.find((o) => text.includes(` ${norm(o)} `));
  if (exact) return exact;

  // 2. synonyms
  for (const o of options) {
    const syns = SYNONYMS[norm(o)];
    if (syns?.some((s) => text.includes(` ${s} `))) return o;
  }

  // 3. best word overlap (ignoring tiny words)
  const words = new Set(
    text
      .trim()
      .split(" ")
      .filter((w) => w.length > 2),
  );
  let best: { option: string; score: number } | undefined;
  for (const o of options) {
    const ow = norm(o)
      .split(" ")
      .filter((w) => w.length > 2);
    if (!ow.length) continue;
    const hits = ow.filter(
      (w) => words.has(w) || [...words].some((x) => x.startsWith(w) || w.startsWith(x)),
    ).length;
    const score = hits / ow.length;
    if (score > 0 && (!best || score > best.score)) best = { option: o, score };
  }
  return best && best.score >= 0.5 ? best.option : undefined;
}

export function matchOptions(input: string, options: readonly string[]): string[] {
  const text = ` ${normalizeUtterance(input).replace(/[^a-z0-9 ]/g, " ")} `;
  return options.filter((o) => text.includes(` ${o.toLowerCase()} `) || matchOption(input, [o]) === o);
}
