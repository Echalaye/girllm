/**
 * Art styles (step 5): every character is drawn either as a realistic
 * photo or as an anime illustration, each with its own image model and
 * prompt conventions.
 *
 *   realistic  RealVisXL-like checkpoint, descriptive photo tags, IP-Adapter face
 *   anime      Animagine XL 4.0, Danbooru tags in its documented order:
 *              "1girl/1boy, …details…, quality tags"
 *
 * Safety: anime models tend to draw characters young-looking, so the
 * subject tags always state an ADULT (mature female / mature male) and the
 * negative prompt carries extra youth-related tags. The minors check of
 * safety.ts still applies to every prompt, whatever the style.
 */
import type { ComfyModelFile } from './ipAdapter.js';
import { ADULT_POSITIVE_TERMS, MINOR_NEGATIVE_TERMS } from './safety.js';

export const ART_STYLES = ['realistic', 'anime'] as const;
export type ArtStyle = (typeof ART_STYLES)[number];

export const GENDERS = ['female', 'male'] as const;
export type Gender = (typeof GENDERS)[number];

/** Extra youth-related negatives for anime models (on top of MINOR_NEGATIVE_TERMS). */
export const ANIME_MINOR_NEGATIVE_TERMS = 'loli, shota, aged down, toddler, child body';

/** Anime model installed by `npm run setup:images -- --anime` (Animagine XL 4.0 Opt). */
export const ANIME_CHECKPOINT_FILE = 'animagine-xl-4.0-opt.safetensors';

/**
 * Animagine XL 4.0 "Opt" (CreativeML Open RAIL++-M), the improved release
 * recommended by its authors. Pinned by SHA-256 like every download.
 */
export const ANIME_MODEL: ComfyModelFile = {
  folder: 'checkpoints',
  file: ANIME_CHECKPOINT_FILE,
  url: `https://huggingface.co/cagliostrolab/animagine-xl-4.0/resolve/main/${ANIME_CHECKPOINT_FILE}`,
  sha256: '6327eca98bfb6538dd7a4edce22484a1bbc57a8cff6b11d075d40da1afb847ac',
  sizeMb: 6939,
};

/** Who is in the picture, always as an adult. */
export function subjectTags(style: ArtStyle, gender: Gender): string {
  if (style === 'anime') {
    return gender === 'male' ? '1boy, solo, adult, mature male' : '1girl, solo, adult, mature female';
  }
  return `${ADULT_POSITIVE_TERMS}, ${gender === 'male' ? 'man' : 'woman'}, solo`;
}

export interface PromptParts {
  style: ArtStyle;
  gender: Gender;
  /** The profile's style / quality tags (IMAGE_STYLE or ANIME_STYLE). */
  styleTags: string;
  /** The card's fixed look (`extensions.girllm.appearance`). */
  appearance: string;
  /** What this picture shows (written by the LLM, or a fixed framing). */
  scene: string;
}

/**
 * Positive prompt. Order matters (CLIP weighs the first tokens most):
 *  - realistic: subject, photo style, appearance, scene;
 *  - anime: subject, appearance, scene, then quality tags last, as the
 *    Animagine documentation recommends.
 */
export function buildPositivePrompt(p: PromptParts): string {
  const parts =
    p.style === 'anime'
      ? [subjectTags('anime', p.gender), p.appearance, p.scene, p.styleTags]
      : [subjectTags('realistic', p.gender), p.styleTags, p.appearance, p.scene];
  return parts
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ');
}

/** Negative prompt: the profile's own, plus the non-negotiable youth terms. */
export function buildNegativePrompt(style: ArtStyle, profileNegative: string): string {
  return [profileNegative, MINOR_NEGATIVE_TERMS, style === 'anime' ? ANIME_MINOR_NEGATIVE_TERMS : '']
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ');
}

/** How the LLM must write the "scene" for each style. */
export function sceneInstructions(style: ArtStyle): string[] {
  return style === 'anime'
    ? [
        '"scene": the picture for an ANIME image generator, in ENGLISH, as 12-30 comma-separated Danbooru tags',
        '  (lowercase, spaces instead of underscores), in this order:',
        '  framing (selfie, upper body, cowboy shot, full body…), pose and expression (looking at viewer, smile…),',
        '  outfit, location with two or three concrete details, lighting and time of day.',
        '  Never add 1girl/1boy, solo, age, character names, rating or quality tags: they are added automatically.',
      ]
    : [
        '"scene": the photo for an image generator, in ENGLISH, as 12-30 comma-separated tags, in this order:',
        '  shot type (close-up selfie, mirror selfie, waist-up photo taken by a friend…), camera angle,',
        '  pose and expression, outfit, location with two or three concrete details, light source, time of day.',
      ];
}
