import { normalizeUtterance } from "./text";

const UNITS: Record<string, number> = {
  zero: 0,
  oh: 0,
  one: 1,
  a: 1,
  an: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fourty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  half: 0.5,
  couple: 2,
};
const MULTIPLIERS: Record<string, number> = {
  hundred: 100,
  thousand: 1_000,
  k: 1_000,
  grand: 1_000,
  lakh: 100_000,
  lakhs: 100_000,
  lac: 100_000,
  lacs: 100_000,
  l: 100_000,
  million: 1_000_000,
  mn: 1_000_000,
  m: 1_000_000,
  crore: 10_000_000,
  crores: 10_000_000,
  cr: 10_000_000,
  billion: 1_000_000_000,
};

/**
 * Parse the first quantity in an utterance:
 *   "80 lakh" → 8000000, "1.2 crore" → 12000000, "eighty five thousand" → 85000,
 *   "50k" → 50000, "around 80 to 90 lakh" → 8000000, "1,20,000" → 120000, "three" → 3.
 * Returns undefined when no number is present.
 */
export function parseNumber(input: string): number | undefined {
  const text = normalizeUtterance(input)
    .replace(/(\d),(?=\d)/g, "$1") // 1,20,000 → 120000
    .replace(/(\d)\s*(k|l|cr|m|mn)\b/g, "$1 $2") // 50k → 50 k
    .replace(/[₹$]|rs\.?|inr|rupees?|dollars?|usd/g, " ")
    .replace(/-/g, " ");
  const tokens = text.split(/[^a-z0-9.]+/).filter(Boolean);

  let i = 0;
  while (i < tokens.length) {
    const start = readQuantity(tokens, i);
    if (start) {
      // "80 to 90 lakh": the multiplier after the range applies to the first number too
      let value = start.value;
      let next = start.next;
      if (!start.multiplied && (tokens[next] === "to" || tokens[next] === "or") && next + 1 < tokens.length) {
        const second = readQuantity(tokens, next + 1);
        if (second?.multiplied && second.multiplier) value *= second.multiplier;
        next = second ? second.next : next;
      }
      return round(value);
    }
    i++;
  }
  return undefined;
}

type Quantity = { value: number; next: number; multiplied: boolean; multiplier?: number };

function readQuantity(tokens: string[], start: number): Quantity | undefined {
  let i = start;
  let base: number | undefined;
  const t0 = tokens[i]!;

  if (/^\d+(\.\d+)?$/.test(t0)) {
    base = Number(t0);
    i++;
  } else if (UNITS[t0] !== undefined && !(t0 === "a" || t0 === "an" || t0 === "oh")) {
    // spelled-out numbers: "eighty five", "one hundred twenty"
    let total = 0;
    let current = 0;
    while (i < tokens.length) {
      const w = tokens[i]!;
      if (UNITS[w] !== undefined && w !== "a" && w !== "an") {
        current += UNITS[w]!;
        i++;
      } else if (w === "hundred") {
        current = (current || 1) * 100;
        i++;
      } else if (
        w === "and" &&
        UNITS[tokens[i + 1] ?? ""] !== undefined &&
        !["a", "an"].includes(tokens[i + 1]!)
      ) {
        i++;
      } else break;
    }
    total += current;
    base = total;
  } else if ((t0 === "a" || t0 === "an") && MULTIPLIERS[tokens[i + 1] ?? ""]) {
    base = 1;
    i++;
  }
  if (base === undefined) return undefined;

  let multiplied = false;
  let multiplier: number | undefined;
  // "one point five crore"
  if (tokens[i] === "point" && UNITS[tokens[i + 1] ?? ""] !== undefined) {
    base = Number(`${base}.${UNITS[tokens[i + 1]!]}`);
    i += 2;
  }
  // "and a half"
  if (tokens[i] === "and" && tokens[i + 1] === "a" && tokens[i + 2] === "half") {
    base += 0.5;
    i += 3;
  }
  while (i < tokens.length && MULTIPLIERS[tokens[i]!]) {
    multiplier = (multiplier ?? 1) * MULTIPLIERS[tokens[i]!]!;
    i++;
    multiplied = true;
  }
  return { value: base * (multiplier ?? 1), next: i, multiplied, multiplier };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Speech-friendly amount: INR uses lakh/crore ("80 lakh rupees"), others use thousand/million */
export function formatAmount(value: number, currency = "INR"): string {
  const trim = (n: number) => Number(n.toFixed(2)).toString();
  if (currency === "INR") {
    if (value >= 10_000_000) return `${trim(value / 10_000_000)} crore rupees`;
    if (value >= 100_000) return `${trim(value / 100_000)} lakh rupees`;
    return `${value.toLocaleString("en-IN")} rupees`;
  }
  const unit = currency === "USD" ? "dollars" : currency;
  if (value >= 1_000_000) return `${trim(value / 1_000_000)} million ${unit}`;
  return `${value.toLocaleString("en-US")} ${unit}`;
}
