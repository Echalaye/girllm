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

/**
 * How the LLM must write the "scene" for FLUX.2 [klein] (step 6): a precise
 * description in sentences. Klein reads its prompt with a language model and
 * fills every gap itself: from a short tag list it invented generic places
 * (a beach for an art-gallery character), stiff front-facing poses and odd
 * details (sand covered in footprints). Everything that matters is written.
 */
export const FLUX_SCENE_INSTRUCTIONS: readonly string[] = [
  '"scene": the photo for a realistic image generator, in ENGLISH, as 4 to 6 short precise sentences, in this order:',
  "  1. The shot: who takes it (selfie at arm's length, mirror selfie, photo taken by a friend a few metres away…),",
  '     the framing (close-up, waist-up, full body) and the camera height/angle.',
  '  2. What they are doing: one simple action, body position, where the hands are, facial expression, where they look.',
  '  3. Their outfit for this moment: each garment with its colour and material.',
  '  4. The place: a specific place from their life or the conversation (their home, their workplace, a place they',
  '     mentioned), never a generic beach or landscape unless asked, with 3 or 4 concrete objects and where they are',
  '     (foreground, background), and the ground or floor.',
  '  5. The light: its source and direction, the time of day and the mood.',
  '  Name each object once, describe only what is visible in this one photo, no other people unless asked.',
];

/** How the LLM must write the "scene" for each style (and image model). */
export function sceneInstructions(style: ArtStyle, engine: 'flux2-klein' | 'sdxl' = 'sdxl'): string[] {
  if (style === 'realistic' && engine === 'flux2-klein') return [...FLUX_SCENE_INSTRUCTIONS];
  return style === 'anime'
    ? [
        '"scene": the picture for an ANIME image generator, in ENGLISH, as 12-30 comma-separated Danbooru tags',
        '  (lowercase, spaces instead of underscores), in this order:',
        '  framing (selfie, upper body, cowboy shot, full body…), pose and expression (looking at viewer, smile…),',
        '  outfit, location with two or three concrete details, lighting and time of day.',
        '  Give the hands one simple thing to do (holding one object, resting), never two actions at once.',
        '  Tag each held object only once (e.g. "holding book"), never two objects for the same hand.',
        '  Never add 1girl/1boy, solo, age, character names, rating or quality tags: they are added automatically.',
      ]
    : [
        '"scene": the photo for an image generator, in ENGLISH, as 12-30 comma-separated tags, in this order:',
        '  shot type (close-up selfie, mirror selfie, waist-up or full body photo taken by a friend…), camera angle,',
        '  pose and expression, outfit, location with two or three concrete details, light source, time of day.',
        '  Give her hands one simple thing to do (holding one object, resting, in her hair), never two actions at once.',
        '  Name each object she holds once ("holding a book"), without describing her hands or fingers.',
      ];
}

/** Taller SDXL frame (~1 megapixel) for full-body pictures. */
export const FULL_BODY_SIZE = { width: 768, height: 1344 } as const;
const FULL_BODY = /\bfull[\s-]?body\b|\bfull[\s-]length\b|\bhead to toe\b/i;

/**
 * Picture size for a scene (step 6). A full body squeezed into the default
 * 832×1216 frame gets short legs or a stretched torso; the taller frame
 * (same pixel count, same speed) gives SDXL room for natural proportions.
 * Only a portrait-oriented configured size is changed: a landscape choice
 * is the user's and is kept. Pure function (exported for tests).
 */
export function frameForScene(scene: string, width: number, height: number): { width: number; height: number } {
  if (height > width && FULL_BODY.test(scene)) return { ...FULL_BODY_SIZE };
  return { width, height };
}
