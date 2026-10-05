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
import { TTS_VOICE_IDS, type TtsVoiceId } from '../voice/catalog.js';
import { ART_STYLES, GENDERS, type ArtStyle, type Gender } from '../images/artStyle.js';

/** Generous but bounded: protects memory and the prompt token budget. */
const text = (max: number) => z.string().max(max).default('');

/**
 * Lorebook ("character_book" in the V2 spec): facts that are only added to
 * the prompt when one of their keywords comes up in the conversation.
 * Unknown keys are kept (passthrough) so SillyTavern data survives a save.
 */
const LoreEntrySchema = z
  .object({
    keys: z.array(z.string().max(100)).max(30).default([]),
    content: text(5_000),
    enabled: z.boolean().default(true),
    /** Always included, whatever the conversation says. */
    constant: z.boolean().default(false),
    case_sensitive: z.boolean().default(false),
    insertion_order: z.number().default(100),
    name: z.string().max(200).optional(),
    comment: z.string().max(2_000).optional(),
  })
  .passthrough();

const CharacterBookSchema = z
  .object({
    name: z.string().max(200).optional(),
    /** How many recent messages are scanned for keywords. */
    scan_depth: z.number().int().min(1).max(50).optional(),
    /** Max tokens the triggered entries may take in the prompt. */
    token_budget: z.number().int().min(50).max(8_000).optional(),
    entries: z.array(LoreEntrySchema).max(500).default([]),
    extensions: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();
export type CharacterBook = z.infer<typeof CharacterBookSchema>;
export type LoreEntry = z.infer<typeof LoreEntrySchema>;

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
  // Free-form app-specific data. girllm reads `extensions.girllm.{appearance,style,voice}`.
  extensions: z.record(z.string(), z.unknown()).default({}),
  character_book: CharacterBookSchema.optional(),
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
  /**
   * Writing style (`extensions.girllm.style`): "texting" = short, natural
   * phone messages; "roleplay" = narrative roleplay with *actions*.
   * Community cards default to "roleplay", which is what they are written for.
   */
  style: CharacterStyle;
  /** Her own voice (`extensions.girllm.voice`); undefined = the voice from the settings. */
  voice: TtsVoiceId | undefined;
  /** How she is drawn (`extensions.girllm.artStyle`): realistic photos (default) or anime. */
  artStyle: ArtStyle;
  /** For pictures (`extensions.girllm.gender`): 1girl/woman (default) or 1boy/man. */
  gender: Gender;
  /** Chat background (`extensions.girllm.background`): her generated scene, or her latest photo. */
  backgroundMode: BackgroundMode;
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

export const CHARACTER_STYLES = ['texting', 'roleplay'] as const;
export type CharacterStyle = (typeof CHARACTER_STYLES)[number];

/** Read `extensions.girllm.style`, defaulting to "roleplay". */
export function readStyle(extensions: Record<string, unknown>): CharacterStyle {
  const girllm = extensions.girllm;
  const style = girllm && typeof girllm === 'object' ? (girllm as { style?: unknown }).style : undefined;
  return (CHARACTER_STYLES as readonly unknown[]).includes(style) ? (style as CharacterStyle) : 'roleplay';
}

export const BACKGROUND_MODES = ['scene', 'latest'] as const;
export type BackgroundMode = (typeof BACKGROUND_MODES)[number];

/** Read a string field of `extensions.girllm` among allowed values, with a default. */
function readEnum<T extends string>(extensions: Record<string, unknown>, key: string, allowed: readonly T[], fallback: T): T {
  const girllm = extensions.girllm;
  const value = girllm && typeof girllm === 'object' ? (girllm as Record<string, unknown>)[key] : undefined;
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

/** Read `extensions.girllm.voice` (a known voice id, or undefined). */
export function readVoice(extensions: Record<string, unknown>): TtsVoiceId | undefined {
  const girllm = extensions.girllm;
  const voice = girllm && typeof girllm === 'object' ? (girllm as { voice?: unknown }).voice : undefined;
  return (TTS_VOICE_IDS as readonly unknown[]).includes(voice) ? (voice as TtsVoiceId) : undefined;
}

/** Build the internal character from validated card fields (one place for every derived field). */
export function characterFromCard(fields: CardFields, id: string, sourceFile: string): Character {
  return {
    ...fields,
    id,
    sourceFile,
    appearance: readAppearance(fields.extensions),
    style: readStyle(fields.extensions),
    voice: readVoice(fields.extensions),
    ...readPictureFields(fields.extensions),
  };
}

/** girllm's picture settings of a card: art style, gender, chat background (validated, with defaults). */
export function readPictureFields(
  extensions: Record<string, unknown>,
): Pick<Character, 'artStyle' | 'gender' | 'backgroundMode'> {
  return {
    artStyle: readEnum(extensions, 'artStyle', ART_STYLES, 'realistic'),
    gender: readEnum(extensions, 'gender', GENDERS, 'female'),
    backgroundMode: readEnum(extensions, 'background', BACKGROUND_MODES, 'scene'),
  };
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

/** One lorebook entry as edited in the app. */
export const LoreInputSchema = z.object({
  name: z.string().trim().max(200).default(''),
  keys: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  content: z.string().trim().min(1).max(5_000),
  enabled: z.boolean().default(true),
  constant: z.boolean().default(false),
  case_sensitive: z.boolean().default(false),
  insertion_order: z.number().int().min(-10_000).max(10_000).default(100),
});
export type LoreInput = z.infer<typeof LoreInputSchema>;

/**
 * What the character editor sends. Same limits as the card format, plus
 * girllm's own fields (style, appearance).
 */
export const CharacterInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(20_000).default(''),
  personality: z.string().max(5_000).default(''),
  scenario: z.string().max(5_000).default(''),
  first_mes: z.string().max(10_000).default(''),
  mes_example: z.string().max(20_000).default(''),
  system_prompt: z.string().max(10_000).default(''),
  post_history_instructions: z.string().max(5_000).default(''),
  creator_notes: z.string().max(10_000).default(''),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  style: z.enum(CHARACTER_STYLES).default('roleplay'),
  appearance: z.string().trim().max(MAX_APPEARANCE_CHARS).default(''),
  /** Her own voice; '' = the voice from the settings. */
  voice: z.union([z.enum(TTS_VOICE_IDS), z.literal('')]).default(''),
  artStyle: z.enum(ART_STYLES).default('realistic'),
  gender: z.enum(GENDERS).default('female'),
  background: z.enum(BACKGROUND_MODES).default('scene'),
  lorebook: z.array(LoreInputSchema).max(200).default([]),
});
export type CharacterInput = z.infer<typeof CharacterInputSchema>;

/** Editable view of a character (what the editor loads). */
export function toInput(c: Character): CharacterInput {
  return {
    name: c.name,
    description: c.description,
    personality: c.personality,
    scenario: c.scenario,
    first_mes: c.first_mes,
    mes_example: c.mes_example,
    system_prompt: c.system_prompt,
    post_history_instructions: c.post_history_instructions,
    creator_notes: c.creator_notes,
    tags: c.tags,
    style: c.style,
    appearance: c.appearance,
    voice: c.voice ?? '',
    artStyle: c.artStyle,
    gender: c.gender,
    background: c.backgroundMode,
    lorebook: (c.character_book?.entries ?? []).map((e) => ({
      name: e.name ?? '',
      keys: e.keys,
      content: e.content,
      enabled: e.enabled,
      constant: e.constant,
      case_sensitive: e.case_sensitive,
      insertion_order: e.insertion_order,
    })),
  };
}
