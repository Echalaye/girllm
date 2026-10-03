/**
 * Rolling summary ("story so far").
 *
 * Instead of silently dropping old messages when the context window fills
 * up, the oldest part of the conversation is folded into a running summary
 * that is always included in the prompt.
 *
 *   [ summarized (seq <= summarizedUntil) ][ recent, sent verbatim ]
 *                                          ^ grows until `triggerTokens`,
 *   then the oldest recent messages are summarized, keeping `keepRecentTokens`.
 */
import type { StoredMessage } from '../chat/sessionStore.js';
import { complete } from '../llm/complete.js';
import type { LlmProvider } from '../llm/types.js';
import { estimateMessageTokens } from '../prompt/tokenEstimator.js';
import { formatTranscript } from './transcript.js';

export interface SummaryPolicy {
  /** Summarize once the verbatim (unsummarized) history exceeds this. */
  triggerTokens: number;
  /** How much recent history to keep verbatim after summarizing. */
  keepRecentTokens: number;
  /** Max size of one batch sent to the summarizer. */
  maxChunkTokens: number;
}

/** Derive a sensible policy from the context window size. */
export function defaultSummaryPolicy(contextTokens: number, maxReplyTokens: number): SummaryPolicy {
  const available = contextTokens - maxReplyTokens;
  return {
    // System prompt + memories + summary take roughly the other half.
    triggerTokens: Math.floor(available * 0.5),
    keepRecentTokens: Math.floor(available * 0.25),
    maxChunkTokens: Math.floor(contextTokens * 0.4),
  };
}

/**
 * Decide which messages to fold into the summary. Pure function (easy to test).
 *
 * @param unsummarized messages with seq > summarizedUntil, oldest first.
 * @returns the oldest messages to summarize, or [] if nothing to do. Always
 *          leaves at least the last 2 messages verbatim (so "regenerate"
 *          never touches summarized content).
 */
export function selectMessagesToSummarize(
  unsummarized: readonly StoredMessage[],
  policy: SummaryPolicy,
): StoredMessage[] {
  const cost = unsummarized.map((m) => estimateMessageTokens(m.content));
  const total = cost.reduce((a, b) => a + b, 0);
  if (total <= policy.triggerTokens || unsummarized.length <= 2) return [];

  // Walk back from the newest message to find where the "recent" tail starts.
  let tailTokens = 0;
  let tailStart = unsummarized.length;
  while (tailStart > 0) {
    const next = cost[tailStart - 1]!;
    const keepsMinimum = unsummarized.length - tailStart < 2;
    if (!keepsMinimum && tailTokens + next > policy.keepRecentTokens) break;
    tailTokens += next;
    tailStart--;
  }

  // Take the head, oldest first, bounded by the chunk size (at least one message).
  const selected: StoredMessage[] = [];
  let chunkTokens = 0;
  for (let i = 0; i < tailStart; i++) {
    if (selected.length > 0 && chunkTokens + cost[i]! > policy.maxChunkTokens) break;
    selected.push(unsummarized[i]!);
    chunkTokens += cost[i]!;
  }
  return selected;
}

export interface SummarizeInput {
  previousSummary: string;
  messages: readonly StoredMessage[];
  charName: string;
  userName: string;
  language?: string | undefined;
}

/** Max summary length requested from the model (keeps the prompt bounded). */
export const SUMMARY_MAX_TOKENS = 450;

export function buildSummaryPrompt(input: SummarizeInput) {
  const language = input.language ? `Write in ${input.language}.` : 'Write in the same language as the conversation.';
  return [
    {
      role: 'system' as const,
      content: [
        `You maintain the running summary of an ongoing roleplay conversation between ${input.userName} and ${input.charName}.`,
        'Merge the new messages into the existing summary. Keep what matters for continuity: events, decisions, promises,',
        'plans, things learned about each other, emotional turning points, and the current situation.',
        'Drop small talk. Never invent anything that is not in the messages.',
        `Write in the third person, past tense, as a compact narrative of at most 250 words. ${language}`,
        'Output only the updated summary, with no title or preamble.',
      ].join(' '),
    },
    {
      role: 'user' as const,
      content: [
        `Existing summary:\n${input.previousSummary.trim() || '(none yet)'}`,
        `New messages:\n${formatTranscript(input.messages, input.charName, input.userName)}`,
        'Updated summary:',
      ].join('\n\n'),
    },
  ];
}

/** Ask the LLM for an updated summary. */
export async function summarize(llm: LlmProvider, input: SummarizeInput): Promise<string> {
  const text = await complete(llm, buildSummaryPrompt(input), {
    maxTokens: SUMMARY_MAX_TOKENS,
    temperature: 0.3, // factual task: low creativity
    topP: 0.9,
  });
  if (!text) throw new Error('Summarizer returned an empty summary');
  return text;
}
