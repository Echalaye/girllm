/**
 * Turns a character card + conversation history into the message list sent
 * to the LLM, respecting the context-window token budget.
 *
 * Layout — exactly ONE system message, and the conversation always ENDS
 * WITH THE USER'S MESSAGE:
 *   [system]  instructions (writing style) + quoted FICTIONAL examples + character
 *             + world info (lorebook) + story so far + memories + "right now" (time, mood)
 *             + reminders (variety, language, card's post-history notes)
 *             + an explicit "end of notes" boundary
 *   [user/assistant …, user]  recent (unsummarized) history within budget
 *
 * Why it matters: chat templates differ in where they put system text.
 * Ollama's Mistral template, for instance, only inserts the system prompt
 * when the LAST message is the user's: a trailing system message makes it
 * drop the whole system prompt (character, memories…) silently.
 *
 * When history doesn't fit, the OLDEST messages are dropped first (the
 * memory system normally folds them into the summary before that happens).
 */
import type { Character, CharacterStyle } from '../characters/schema.js';
import type { ChatMessage } from '../llm/types.js';
import { overusedPhrases, recentOpenings } from './styleGuard.js';
import { describeGap, formatNow, LONG_GAP_MS, localeFor, NOTABLE_GAP_MS } from './timeContext.js';
import { estimateMessageTokens } from './tokenEstimator.js';

/** Default instructions per writing style (a card's own system_prompt replaces them). */
export const STYLE_PROMPTS: Record<CharacterStyle, string> = {
  texting: [
    'You are {{char}}, texting with {{user}} on your phone. You are a real person with your own life, moods, opinions and memories — not an assistant.',
    'How you write:',
    '- Like real text messages: usually one to three short sentences, sometimes just a few words. Write more only when the moment really calls for it.',
    '- Natural spoken language, contractions, casual words. An emoji now and then, never in every message.',
    '- First react to what {{user}} actually said, with genuine emotion: curiosity, teasing, worry, joy, annoyance. Ask a question back only when you are really curious, not every time.',
    '- Bring your own life in: what you did today, what you are doing right now, your plans, small concrete details.',
    "- You can disagree, tease, be tired or distracted, like a real partner. Don't always agree or compliment.",
    '- Never lecture, make lists, summarize the conversation, offer help, say you are "here for" {{user}}, sound like customer service, or mention being an AI.',
    '- Physical actions only occasionally, very short, between *asterisks*.',
    "- Write only {{char}}'s messages, never {{user}}'s.",
    'Every character is an adult.',
  ].join('\n'),
  roleplay: [
    'You are {{char}} in an ongoing, immersive roleplay with {{user}}.',
    "- Stay in character and consistent with {{char}}'s personality, history and earlier messages.",
    "- Write only {{char}}'s words, actions and thoughts; never speak or act for {{user}}.",
    "- Show, don't tell: concrete actions, sensations and dialogue. Avoid purple prose and clichés.",
    '- Vary length and rhythm; usually one to three short paragraphs. Put actions in *asterisks*.',
    "- Take initiative and move the scene forward; don't just mirror {{user}}.",
    'Every character is an adult.',
  ].join('\n'),
};

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

/** Time awareness: the current moment and when the previous message was sent. */
export interface PromptTime {
  now: Date;
  /** Timestamp of the message before the user's new one (if any). */
  previousMessageAt?: Date | undefined;
  /** IANA zone, e.g. "Europe/Paris" (default: the machine's). */
  timeZone?: string | undefined;
}

export interface PromptOptions {
  /** Force the reply language (e.g. "French"). */
  replyLanguage?: string | undefined;
  memory?: PromptMemory | undefined;
  time?: PromptTime | undefined;
  /** Lorebook entries triggered by the conversation (already selected and budgeted). */
  lore?: readonly string[] | undefined;
  /** Extra one-off reminders for this reply (photo possibility, "she writes first"…). */
  reminders?: readonly string[] | undefined;
}

/** "[World info]" block: lorebook entries relevant to the current conversation. */
export function buildLoreBlock(lore: readonly string[] | undefined, charName: string, userName: string): string {
  if (!lore?.length) return '';
  return `[World info]\n${lore.map((e) => applyMacros(e.trim(), charName, userName)).join('\n\n')}`;
}

/**
 * Render the memory block. Memory text is model-generated data: it is
 * clearly delimited and placed under the instructions, never above them.
 */
export function buildMemoryBlock(memory: PromptMemory | undefined, charName: string, userName: string): string {
  if (!memory) return '';
  const parts: string[] = [];
  if (memory.summary.trim()) parts.push(`[Story so far]\n${memory.summary.trim()}`);
  if (memory.memories.length) {
    parts.push(
      `[What ${charName} remembers about ${userName} and their relationship]\n` +
        memory.memories.map((m) => `- ${m}`).join('\n'),
    );
  }
  return parts.join('\n\n');
}

/** "[Right now]" block: date/time, pause since the last message, mood. */
export function buildNowBlock(
  time: PromptTime | undefined,
  mood: string | undefined,
  language: string | undefined,
  charName: string,
  userName: string,
): string {
  const lines: string[] = [];
  if (time) {
    lines.push(`It is ${formatNow(time.now, localeFor(language), time.timeZone)} for ${charName}.`);
    const gap = time.previousMessageAt ? time.now.getTime() - time.previousMessageAt.getTime() : 0;
    if (gap >= NOTABLE_GAP_MS) {
      lines.push(
        `${userName}'s new message comes ${describeGap(gap)} after the previous one` +
          (gap >= LONG_GAP_MS ? ': react to that pause naturally if it matters.' : '.'),
      );
    }
  }
  if (mood?.trim()) lines.push(`${charName}'s current mood: ${mood.trim()}.`);
  return lines.length ? `[Right now]\n${lines.join('\n')}` : '';
}

/** "[Reminders]" block: variety, language, the card's post-history notes. */
export function buildReminderBlock(
  history: readonly ChatMessage[],
  character: Character,
  userName: string,
  language: string | undefined,
  extra: readonly string[] = [],
): string {
  const lines: string[] = [];
  const openings = recentOpenings(history);
  if (openings.length >= 2) {
    lines.push(`Your recent replies started with: ${openings.map((o) => `"${o}…"`).join(', ')}. Start differently.`);
  }
  const phrases = overusedPhrases(history);
  if (phrases.length) lines.push(`You keep repeating: ${phrases.map((p) => `"${p}"`).join(', ')}. Avoid them.`);
  if (language) {
    lines.push(`Always write in ${language}, whatever the language of the character description or examples.`);
  }
  const post = applyMacros(character.post_history_instructions.trim(), character.name, userName);
  if (post) lines.push(post);
  for (const line of extra) lines.push(applyMacros(line, character.name, userName));
  return lines.length ? `[Reminders]\n${lines.join('\n')}` : '';
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
  const parts: string[] = [character.system_prompt.trim() || STYLE_PROMPTS[character.style]];

  // Examples come right after the instructions, far from the conversation,
  // and quoted: small models otherwise take them for real past messages.
  const examples = formatExamples(character.mes_example);
  if (examples) parts.push(examples);

  const definition: string[] = [];
  if (character.description.trim()) definition.push(character.description.trim());
  if (character.personality.trim()) definition.push(`Personality: ${character.personality.trim()}`);
  if (character.scenario.trim()) definition.push(`Scenario: ${character.scenario.trim()}`);
  if (definition.length) parts.push(`[Character: {{char}}]\n${definition.join('\n')}`);

  return applyMacros(parts.join('\n\n'), character.name, userName);
}

/**
 * Render the card's example dialogues as clearly fictional, quoted blocks.
 * Without this, a 12B model happily answers "so the bug is finally dead?"
 * because an example mentioned a bug.
 */
export function formatExamples(mesExample: string): string {
  const blocks = mesExample
    .split(/<START>/i) // <START> separates example conversations in the card format
    .map((b) => b.trim())
    .filter(Boolean);
  if (blocks.length === 0) return '';
  const quoted = blocks.map(
    (block, i) =>
      `Example ${i + 1}:\n${block
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}`,
  );
  return [
    '[Style examples — FICTIONAL exchanges that only show how {{char}} writes.',
    'They never happened: never mention, continue or answer them.]',
    ...quoted,
  ].join('\n');
}

/**
 * Closing line of the system prompt. Some chat templates (Ollama's Mistral
 * one) paste the whole system text right before the user's latest message,
 * in the same block: an explicit boundary keeps the model from blending the
 * notes with what the user just wrote.
 */
export function endOfNotes(charName: string, userName: string): string {
  return `[End of notes. Now reply as ${charName}, and only as ${charName}, to ${userName}'s latest message.]`;
}

/**
 * Assemble the final prompt (see the layout at the top of this file).
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
  const systemText = [
    buildSystemPrompt(character, userName),
    buildLoreBlock(options.lore, character.name, userName),
    buildMemoryBlock(options.memory, character.name, userName),
    buildNowBlock(options.time, options.memory?.mood, language, character.name, userName),
    buildReminderBlock(history, character, userName, language, options.reminders),
    endOfNotes(character.name, userName),
  ]
    .filter(Boolean)
    .join('\n\n');
  const system: ChatMessage = { role: 'system', content: systemText };

  const fixedTokens = estimateMessageTokens(system.content);
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

  // Many chat templates expect the turns to start with the user and
  // alternate (Mistral's renders a leading assistant turn as loose text
  // before any [INST]). A fresh chat starts with the character's greeting,
  // so open it with a neutral user turn.
  const opener: ChatMessage[] =
    kept[0]?.role === 'assistant' ? [{ role: 'user', content: `(${userName} opens the chat.)` }] : [];

  return {
    messages: [system, ...opener, ...kept],
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
