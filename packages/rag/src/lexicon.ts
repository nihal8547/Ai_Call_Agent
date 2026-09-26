/**
 * Words for keyword search and relevance checks. Semantic embeddings handle paraphrases; this keeps
 * keyword-only search (no embedding provider, or the provider timed out) useful for how callers talk.
 */

/** Function words and conversational filler that say nothing about what is asked */
export const STOPWORDS = new Set(
  (
    "a an and are as at be by can could do does did for from have has had how i if in is it its me my of on or our " +
    "please should tell that the their them there these they this to was we what when where which who why will with " +
    "would you your about any also am just know like need want get got give much many there's what's i'm i'd we're " +
    "you're it's is it provide provides available right now currently actually really here okay ok yes hi hello " +
    "sir madam maam one some kind sort thing things let us anything something stuff come comes leave work works"
  ).split(" "),
);

/**
 * Caller words → words businesses write. Each group is equivalent for matching; kept small and
 * generic (English) on purpose.
 */
const GROUPS: string[][] = [
  ["car", "cars", "vehicle", "park", "parking", "valet"],
  ["bike", "scooter", "two-wheeler", "wheeler"],
  ["kid", "kids", "child", "children", "baby", "babies"],
  ["dog", "dogs", "cat", "cats", "pet", "pets"],
  [
    "price",
    "prices",
    "cost",
    "costs",
    "charge",
    "charges",
    "fee",
    "fees",
    "rate",
    "rates",
    "tariff",
    "expensive",
    "cheap",
    "cheapest",
    "budget",
  ],
  ["timing", "timings", "hour", "hours", "open", "opening", "close", "closing", "closed", "time"],
  ["beer", "wine", "alcohol", "drinks", "bar", "liquor"],
  ["veg", "vegetarian", "veggie"],
  ["address", "located", "location", "where", "directions", "landmark"],
  ["wifi", "wi-fi", "internet"],
  ["pay", "payment", "payments", "upi", "card", "cards", "cash"],
  ["cancel", "cancellation", "cancelling", "refund"],
  ["loan", "loans", "emi", "finance", "financing", "mortgage"],
  ["discount", "discounts", "offer", "offers", "deal", "deals", "waiving", "waived"],
  ["doctor", "doctors", "dentist", "dentists", "dr"],
  ["checkin", "check-in"],
  ["checkout", "check-out"],
  ["breakfast", "buffet"],
  ["outdoor", "outside", "terrace", "rooftop"],
  ["amenity", "amenities", "facility", "facilities"],
  ["book", "booking", "reserve", "reservation", "reservations"],
  ["deliver", "delivery", "swiggy", "zomato"],
  ["ready", "possession", "handover", "move-in"],
  ["completed", "delivered", "built"],
  ["flat", "flats", "apartment", "apartments", "bhk"],
  ["checkin", "check-in", "arrive", "arrival"],
];

const stem = (w: string) => (w.length > 4 ? w.replace(/(ies|es|s)$/, (m) => (m === "ies" ? "y" : "")) : w);

const SYNONYMS = new Map<string, string[]>();
for (const group of GROUPS) {
  const stems = [...new Set(group.map(stem))];
  for (const w of stems) SYNONYMS.set(w, stems);
}

/** Lower-case words, with "3BHK" → "3 bhk" and "24/7" kept apart */
export function tokens(text: string): string[] {
  return (
    text
      .toLowerCase()
      .normalize("NFKC")
      .replace(/(\d)(\p{L})/gu, "$1 $2")
      .replace(/(\p{L})(\d)/gu, "$1 $2")
      .match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? []
  );
}

/** Content words, lightly stemmed ("patients" → "patient") */
export function contentWords(text: string): string[] {
  const words = tokens(text)
    .filter((w) => !STOPWORDS.has(w) && (w.length > 1 || /\d/.test(w)))
    .map(stem);
  return [...new Set(words)];
}

/** A word and its equivalents */
export function variants(word: string): string[] {
  return SYNONYMS.get(word) ?? [word];
}
