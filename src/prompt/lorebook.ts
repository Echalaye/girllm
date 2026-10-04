/**
 * Lorebook ("world info"): picks the entries of a character's book that the
 * conversation is currently about, so long background knowledge (her
 * family, her job, places, past events…) costs prompt space only when it
 * matters.
 *
 * Rules (compatible with the usual SillyTavern semantics, simplified):
 *  - an enabled entry is triggered when one of its keys appears in the last
 *    `scanDepth` messages (whole-word match, case-insensitive unless the
 *    entry says otherwise); `constant` entries are always included;
 *  - keys are plain text, never regular expressions (no ReDoS from a card);
 *  - when the triggered entries exceed the token budget, the ones with the
 *    highest `insertion_order` are kept; the kept ones are then written in
 *    ascending order.
 */
import type { CharacterBook } from '../characters/schema.js';
import { estimateMessageTokens } from './tokenEstimator.js';

export const DEFAULT_SCAN_DEPTH = 4;

/** Escape a string for use inside a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word match that works with accents ("café") and apostrophes. */
function keyMatches(key: string, haystack: string, caseSensitive: boolean): boolean {
  const k = key.trim();
  if (!k) return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(k)}(?![\\p{L}\\p{N}])`, caseSensitive ? 'u' : 'iu');
  return re.test(haystack);
}

/**
 * @param book       the character's lorebook (may be undefined)
 * @param recent     recent message texts, oldest first (the user's new message last)
 * @param maxTokens  budget when the book doesn't set one
 * @returns the contents to inject, in prompt order
 */
export function selectLore(book: CharacterBook | undefined, recent: readonly string[], maxTokens: number): string[] {
  if (!book?.entries.length) return [];
  const depth = book.scan_depth ?? DEFAULT_SCAN_DEPTH;
  const haystack = recent.slice(-depth).join('\n');
  const budget = Math.min(book.token_budget ?? maxTokens, maxTokens);

  const triggered = book.entries.filter(
    (e) =>
      e.enabled && e.content.trim() && (e.constant || e.keys.some((k) => keyMatches(k, haystack, e.case_sensitive))),
  );

  // Most important first while filling the budget…
  const byPriority = [...triggered].sort((a, b) => b.insertion_order - a.insertion_order);
  const kept = new Set<(typeof triggered)[number]>();
  let used = 0;
  for (const entry of byPriority) {
    const cost = estimateMessageTokens(entry.content);
    if (used + cost > budget) continue; // a smaller entry may still fit
    kept.add(entry);
    used += cost;
  }
  // …then in their natural order.
  return triggered
    .filter((e) => kept.has(e))
    .sort((a, b) => a.insertion_order - b.insertion_order)
    .map((e) => e.content.trim());
}
