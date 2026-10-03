/**
 * Detects repetition in the character's recent replies, so the prompt can
 * nudge the model away from it. Small models loop on the same openings
 * ("Oh, …", "Haha …") and pet phrases; pointing at them explicitly works
 * better than generic "don't repeat yourself" instructions.
 */
import type { ChatMessage } from '../llm/types.js';

/** Words ignored when deciding whether a phrase is "meaningful". */
const STOPWORDS = new Set(
  (
    'the a an and or but to of in on at for with is are was be it i you he she we they me my your that this so ' +
    'le la les un une des et ou mais à au aux de du en dans sur pour avec est es suis sont je tu il elle on nous vous ' +
    'ils elles me te se mon ma mes ton ta tes son sa ses ce cette que qui ne pas plus très'
  ).split(' '),
);

/** Visible words of a reply, without *actions*, emojis or punctuation. */
export function words(text: string): string[] {
  return text
    .replace(/\*[^*]*\*/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'’ -]+/gu, ' ') // keep both apostrophes (' and ’, common in French)
    .split(/\s+/)
    .filter(Boolean);
}

/** First `n` words of a reply (its "opening"). */
export function opening(text: string, n = 3): string {
  return words(text).slice(0, n).join(' ');
}

/** Openings of the last `count` assistant replies, newest first, distinct. */
export function recentOpenings(history: readonly ChatMessage[], count = 3): string[] {
  const out: string[] = [];
  for (let i = history.length - 1; i >= 0 && out.length < count; i--) {
    const m = history[i]!;
    if (m.role !== 'assistant') continue;
    const o = opening(m.content);
    if (o && !out.includes(o)) out.push(o);
  }
  return out;
}

/**
 * Phrases (4 consecutive words) found in at least two of the last `window`
 * assistant replies. Phrases made only of stopwords are ignored.
 * @returns up to `max` phrases, most frequent first.
 */
export function overusedPhrases(history: readonly ChatMessage[], window = 6, max = 4): string[] {
  const replies = history.filter((m) => m.role === 'assistant').slice(-window);
  const seenIn = new Map<string, number>();
  for (const reply of replies) {
    const w = words(reply.content);
    const grams = new Set<string>();
    for (let i = 0; i + 4 <= w.length; i++) {
      const gram = w.slice(i, i + 4);
      if (gram.some((x) => x.length > 3 && !STOPWORDS.has(x))) grams.add(gram.join(' '));
    }
    for (const g of grams) seenIn.set(g, (seenIn.get(g) ?? 0) + 1);
  }
  return [...seenIn.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([g]) => g)
    .slice(0, max);
}
