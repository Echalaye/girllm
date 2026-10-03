/**
 * Turns a character card + conversation history into the message list sent
 * to the LLM, respecting the context-window token budget.
 *
 * Layout:
 *   [system]    instructions + character definition + example dialogue
 *               + long-term memories + story so far (summary) + mood
 *   [user/assistant ...] recent (unsummarized) history that fits the budget
 *   [system]    post-history instructions / language reminder
 *
 * The memory system keeps the verbatim history short by folding old
 * messages into the summary; if it still doesn't fit (e.g. the summary job
 * hasn't run yet), the OLDEST messages are dropped first.
 */
import type { Character } from '../characters/schema.js';
import type { ChatMessage } from '../llm/types.js';
import { estimateMessageTokens } from './tokenEstimator.js';

export const DEFAULT_SYSTEM_PROMPT = [
  'You are {{char}} in an ongoing, immersive roleplay conversation with {{user}}.',
  "Stay in character at all times and stay consistent with {{char}}'s personality and past messages.",
  "Write only {{char}}'s words, actions and thoughts; never speak or act on behalf of {{user}}.",
  'Keep replies natural and fairly concise (one to three short paragraphs). Put actions in *asterisks*.',
  'Every character in this story is an adult.',
].join('\n');

/** Tokens kept free to absorb estimation error. */
const SAFETY_MARGIN_TOKENS = 64;

export interface PromptBudget {
  contextTokens: number;
  maxReplyTokens: number;
}

/** Long-term context provided by the memory system. */
export interface PromptMemory {
  /** Running summary of the older part of the conversation. */
  summary: string;
  /** Relevant long-term memories (one sentence each). */
  memories: readonly string[];
  /** Character's current mood (may be empty). */
  mood: string;
}

export interface PromptOptions {
  /** Force the reply language (e.g. "French"). */
  replyLanguage?: string | undefined;
  memory?: PromptMemory | undefined;
}

/**
 * Render the memory block appended to the system prompt. Memory text is
 * model-generated data: it is clearly delimited and never given authority
 * over the instructions above it.
 */
export function buildMemoryBlock(memory: PromptMemory | undefined, charName: string, userName: string): string {
  if (!memory) return '';
  const parts: string[] = [];
  if (memory.memories.length) {
    parts.push(
      `[What ${charName} remembers about ${userName} and their relationship]\n` +
        memory.memories.map((m) => `- ${m}`).join('\n'),
    );
  }
  if (memory.summary.trim()) parts.push(`[Story so far]\n${memory.summary.trim()}`);
  if (memory.mood.trim()) parts.push(`[${charName}'s current mood: ${memory.mood.trim()}]`);
  return parts.join('\n\n');
}

export interface BuiltPrompt {
  messages: ChatMessage[];
  /** Estimated prompt size (for logs / UI). */
  estimatedTokens: number;
  /** How many history messages were left out because of the budget. */
  droppedMessages: number;
}

export class PromptTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptTooLargeError';
  }
}

/**
 * Replace SillyTavern-style macros. Case-insensitive, also supports the
 * legacy <BOT>/<USER> placeholders. `$` in names is safe because we use a
 * replacer function instead of a replacement string.
 */
export function applyMacros(text: string, charName: string, userName: string): string {
  return text.replace(/\{\{char\}\}|<bot>/gi, () => charName).replace(/\{\{user\}\}|<user>/gi, () => userName);
}

/** Build the static system block describing the character. */
export function buildSystemPrompt(character: Character, userName: string): string {
  const parts: string[] = [character.system_prompt.trim() || DEFAULT_SYSTEM_PROMPT];

  const definition: string[] = [];
  if (character.description.trim()) definition.push(character.description.trim());
  if (character.personality.trim()) definition.push(`Personality: ${character.personality.trim()}`);
  if (character.scenario.trim()) definition.push(`Scenario: ${character.scenario.trim()}`);
  if (definition.length) parts.push(`[Character: {{char}}]\n${definition.join('\n')}`);

  const examples = character.mes_example.trim();
  if (examples) {
    // <START> separates example conversations in the card format.
    const cleaned = examples.replace(/<START>/gi, '---').trim();
    parts.push(`[Example dialogue — style reference only, not real events]\n${cleaned}`);
  }

  return applyMacros(parts.join('\n\n'), character.name, userName);
}

/**
 * Assemble the final prompt.
 *
 * When `replyLanguage` is set, the instruction is given twice: in the
 * system prompt and again after the history. Small models tend to drift
 * back to the language of the card or examples; a reminder placed right
 * before generation is the most reliable fix.
 *
 * @param history full conversation, oldest first; must end with the user's
 *                new message (it is always kept).
 * @throws PromptTooLargeError if even the character definition + the last
 *         message exceed the budget.
 */
export function buildPrompt(
  character: Character,
  history: readonly ChatMessage[],
  userName: string,
  budget: PromptBudget,
  options: PromptOptions = {},
): BuiltPrompt {
  const language = options.replyLanguage;
  const languageRule = language
    ? `Always write your replies in ${language}, whatever the language of the character description or examples.`
    : '';

  const systemText = [
    buildSystemPrompt(character, userName),
    buildMemoryBlock(options.memory, character.name, userName),
    languageRule,
  ]
    .filter(Boolean)
    .join('\n\n');
  const system: ChatMessage = { role: 'system', content: systemText };

  const postParts = [
    applyMacros(character.post_history_instructions.trim(), character.name, userName),
    language ? `(Reply in ${language}.)` : '',
  ].filter(Boolean);
  const post: ChatMessage | undefined = postParts.length
    ? { role: 'system', content: postParts.join('\n') }
    : undefined;

  const fixedTokens = estimateMessageTokens(system.content) + (post ? estimateMessageTokens(post.content) : 0);
  const available = budget.contextTokens - budget.maxReplyTokens - SAFETY_MARGIN_TOKENS - fixedTokens;

  // Walk from newest to oldest, keeping messages while they fit.
  const kept: ChatMessage[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!;
    const cost = estimateMessageTokens(msg.content);
    if (used + cost > available) break;
    kept.push(msg);
    used += cost;
  }

  if (history.length > 0 && kept.length === 0) {
    throw new PromptTooLargeError(
      'The character definition plus your message exceed the context window. ' +
        'Shorten the message, trim the card, or raise CONTEXT_TOKENS.',
    );
  }
  kept.reverse();

  // Some chat templates require the first non-system turn to be "user".
  // If trimming left an assistant message first, drop it. (A fresh chat
  // legitimately starts with the character's greeting: that one is kept.)
  const trimmed = kept.length < history.length;
  while (trimmed && kept.length > 1 && kept[0]!.role === 'assistant') {
    used -= estimateMessageTokens(kept.shift()!.content);
  }

  const messages = [system, ...kept, ...(post ? [post] : [])];
  return {
    messages,
    estimatedTokens: fixedTokens + used,
    droppedMessages: history.length - kept.length,
  };
}

/**
 * Stop sequences preventing the model from writing the user's next turn —
 * a classic failure of small roleplay models.
 */
export function stopSequencesFor(userName: string): string[] {
  return [`\n${userName}:`, `\n**${userName}:**`];
}
