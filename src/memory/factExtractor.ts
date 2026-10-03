/**
 * Extracts durable facts (and the character's current mood) from recent
 * messages, using the chat model itself with a strict JSON output format.
 */
import { z } from 'zod';
import type { StoredMessage } from '../chat/sessionStore.js';
import { complete } from '../llm/complete.js';
import type { LlmProvider } from '../llm/types.js';
import { MEMORY_CATEGORIES, type MemoryCategory } from './memoryStore.js';
import { formatTranscript } from './transcript.js';

export const MAX_FACTS_PER_RUN = 8;
export const MAX_FACT_CHARS = 300;
export const MAX_MOOD_CHARS = 80;

export interface ExtractedFact {
  category: MemoryCategory;
  content: string;
}

export interface ExtractionResult {
  facts: ExtractedFact[];
  mood: string;
}

/** Tolerant schemas: small models often add fields or vary casing. */
const FactSchema = z.object({
  category: z
    .string()
    .transform((c) => c.toLowerCase().trim())
    .pipe(z.enum(MEMORY_CATEGORIES)),
  content: z.string().trim().min(3).max(MAX_FACT_CHARS),
});
const MoodSchema = z.string().trim().max(MAX_MOOD_CHARS);

export interface ExtractInput {
  messages: readonly StoredMessage[];
  charName: string;
  userName: string;
  /** Facts already known, so the model doesn't repeat them. */
  knownFacts: readonly string[];
  language?: string | undefined;
}

export function buildExtractionPrompt(input: ExtractInput) {
  const { charName: char, userName: user } = input;
  const language = input.language ? `Write the facts in ${input.language}.` : 'Write the facts in the language of the conversation.';
  const known = input.knownFacts.length ? input.knownFacts.map((f) => `- ${f}`).join('\n') : '(none)';
  return [
    {
      role: 'system' as const,
      content: [
        `You extract long-term memories from a roleplay conversation between ${user} and ${char}.`,
        'Return ONLY a JSON object: {"facts": [{"category": "...", "content": "..."}], "mood": "..."}.',
        'Categories:',
        `"user" = a durable fact about ${user} (job, tastes, family, plans, important life events);`,
        `"character" = something ${char} said about herself that must stay consistent;`,
        '"relationship" = how they relate (nicknames, habits together, boundaries, feelings expressed);',
        '"event" = something notable that happened or was promised/planned.',
        'Rules: only facts explicitly stated in the NEW messages; no guesses; skip small talk and anything already known;',
        `one short self-contained sentence per fact, naming people (e.g. "${user} works as a data scientist");`,
        `at most ${MAX_FACTS_PER_RUN} facts; an empty list is fine.`,
        `"mood" = ${char}'s current emotional state in a few words.`,
        language,
      ].join('\n'),
    },
    {
      role: 'user' as const,
      content: `Already known:\n${known}\n\nNew messages:\n${formatTranscript(input.messages, char, user)}\n\nJSON:`,
    },
  ];
}

/**
 * Parse the model output. Accepts JSON wrapped in prose or ``` fences, which
 * small models frequently produce. Invalid facts are dropped individually.
 */
export function parseExtraction(raw: string): ExtractionResult {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return { facts: [], mood: '' };

  let json: unknown;
  try {
    json = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { facts: [], mood: '' };
  }
  if (!json || typeof json !== 'object') return { facts: [], mood: '' };

  // Validate facts one by one so a single bad item doesn't discard the rest.
  const obj = json as { facts?: unknown; mood?: unknown };
  const facts = (Array.isArray(obj.facts) ? obj.facts : [])
    .map((f) => FactSchema.safeParse(f))
    .flatMap((r) => (r.success ? [r.data] : []))
    .slice(0, MAX_FACTS_PER_RUN);
  const mood = MoodSchema.safeParse(obj.mood);
  return { facts, mood: mood.success ? mood.data : '' };
}

export async function extractFacts(llm: LlmProvider, input: ExtractInput): Promise<ExtractionResult> {
  const raw = await complete(llm, buildExtractionPrompt(input), {
    maxTokens: 500,
    temperature: 0.2,
    topP: 0.9,
  });
  return parseExtraction(raw);
}
