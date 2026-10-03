/**
 * Character card schemas.
 *
 * We read the community "Character Card V2" format (used by SillyTavern,
 * chub.ai, RisuAI…) and the older flat V1 format, then normalise both into
 * our internal `Character` type. Compatibility means thousands of existing
 * cards work out of the box and ours can be tested in SillyTavern.
 *
 * Spec: https://github.com/malfoyslastname/character-card-spec-v2
 */
import { z } from 'zod';

/** Generous but bounded: protects memory and the prompt token budget. */
const text = (max: number) => z.string().max(max).default('');

const CardFieldsSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: text(20_000),
  personality: text(5_000),
  scenario: text(5_000),
  first_mes: text(10_000),
  mes_example: text(20_000),
  // V2-only fields (absent in V1 — defaults apply).
  system_prompt: text(10_000),
  post_history_instructions: text(5_000),
  alternate_greetings: z.array(z.string().max(10_000)).max(50).default([]),
  creator_notes: text(10_000),
  tags: z.array(z.string().max(100)).max(100).default([]),
  creator: text(200),
  character_version: text(50),
  // Free-form app-specific data. girllm reads `extensions.girllm.appearance`.
  extensions: z.record(z.string(), z.unknown()).default({}),
});

export const CardV2Schema = z.object({
  spec: z.literal('chara_card_v2'),
  spec_version: z.string().optional(),
  data: CardFieldsSchema,
});

/** V1 cards are the bare field object (unknown extra keys are tolerated). */
export const CardV1Schema = CardFieldsSchema;

export type CardFields = z.infer<typeof CardFieldsSchema>;

/** Internal, normalised character used by the rest of the app. */
export interface Character extends CardFields {
  /** Stable id derived from the file name (safe for URLs). */
  id: string;
  /**
   * Fixed image-prompt description of how the character looks
   * (`extensions.girllm.appearance`), so every photo shows the same person.
   * Empty if the card doesn't define one.
   */
  appearance: string;
  /** Where the card was loaded from — for logs only, never sent to clients. */
  sourceFile: string;
}

/** Public view of a character (no file paths, no prompt internals). */
export interface CharacterSummary {
  id: string;
  name: string;
  creatorNotes: string;
  tags: string[];
}

export function toSummary(c: Character): CharacterSummary {
  return { id: c.id, name: c.name, creatorNotes: c.creator_notes, tags: c.tags };
}

/** Max length of `extensions.girllm.appearance`. */
export const MAX_APPEARANCE_CHARS = 500;

/** Read `extensions.girllm.appearance` defensively (any shape may be found in the wild). */
export function readAppearance(extensions: Record<string, unknown>): string {
  const girllm = extensions.girllm;
  if (!girllm || typeof girllm !== 'object') return '';
  const appearance = (girllm as { appearance?: unknown }).appearance;
  return typeof appearance === 'string' ? appearance.trim().slice(0, MAX_APPEARANCE_CHARS) : '';
}
