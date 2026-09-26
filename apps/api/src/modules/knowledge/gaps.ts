import { contentWords } from "@platform/rag";

export type AskedQuestion = { question: string; callId: string; at: Date; reason: string | null };

export type KnowledgeGap = {
  key: string;
  question: string;
  count: number;
  lastAskedAt: string;
  reasons: string[];
  examples: { question: string; callId: string; at: string }[];
};

/** Stable key for a question's meaning: its sorted content words ("parking patient") */
export const gapKey = (question: string) => [...contentWords(question)].sort().join(" ");

const jaccard = (a: Set<string>, b: Set<string>) => {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter || 1);
};

/**
 * Group unanswered questions that ask the same thing ("is there parking?", "where can I park?"
 * share "park…") so the business sees each missing answer once, with how often it was asked.
 */
export function groupGaps(asked: AskedQuestion[], resolvedKeys: Set<string>): KnowledgeGap[] {
  const groups: { words: Set<string>; items: AskedQuestion[] }[] = [];
  for (const q of asked) {
    const words = new Set(contentWords(q.question).map((w) => w.slice(0, 5)));
    if (!words.size) continue;
    const group = groups.find((g) => jaccard(g.words, words) >= 0.5);
    if (group) {
      group.items.push(q);
      for (const w of words) group.words.add(w);
    } else groups.push({ words, items: [q] });
  }
  return groups
    .map((g) => {
      const items = [...g.items].sort((a, b) => b.at.getTime() - a.at.getTime());
      // The most common wording represents the group
      const counts = new Map<string, number>();
      for (const i of items) counts.set(i.question, (counts.get(i.question) ?? 0) + 1);
      const question = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]![0];
      return {
        key: gapKey(question),
        question,
        count: items.length,
        lastAskedAt: items[0]!.at.toISOString(),
        reasons: [...new Set(items.map((i) => i.reason).filter((r): r is string => Boolean(r)))],
        examples: items
          .slice(0, 5)
          .map((i) => ({ question: i.question, callId: i.callId, at: i.at.toISOString() })),
      };
    })
    .filter((g) => !resolvedKeys.has(g.key))
    .sort((a, b) => b.count - a.count || b.lastAskedAt.localeCompare(a.lastAskedAt));
}
