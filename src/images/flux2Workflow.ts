/**
 * FLUX.2 [klein] 4B (Black Forest Labs, Apache 2.0), image test bench only
 * for now (step 6b): it is compared with the SDXL models before any use in
 * the app.
 *
 * Unlike an SDXL checkpoint (one file), FLUX.2 comes as three files, each in
 * its own ComfyUI folder: the diffusion model, the Qwen3 4B text encoder and
 * the FLUX.2 VAE. The graph follows ComfyUI's official "Flux.2 Klein 4B
 * Distilled" templates and uses core nodes only (recent ComfyUI needed):
 *
 *   UNETLoader ─┐                           RandomNoise ─┐
 *   CLIPLoader ─► CLIPTextEncode ─► (+ ReferenceLatent: her face)
 *                      └► ConditioningZeroOut (negative)  ─► CFGGuider (cfg 1)
 *   EmptyFlux2LatentImage + Flux2Scheduler (4 steps) + KSamplerSelect (euler)
 *     ─► SamplerCustomAdvanced ─► VAEDecode ─► SaveImage
 *
 * The distilled model runs at CFG 1: the negative prompt is zeroed out and
 * has no effect. The "no minors" rule therefore relies on the adult terms
 * of the positive prompt and the code-side text check (safety.ts) alone,
 * which is one reason this stays in the bench until reviewed.
 */
import type { ArtStyle, Gender } from './artStyle.js';
import type { CropBox } from './detailWorkflow.js';
import type { FaceBox } from './faceDetector.js';
import type { ComfyModelFile } from './ipAdapter.js';
import type { ComfyWorkflow } from './workflow.js';

const KLEIN = 'https://huggingface.co/Comfy-Org/flux2-klein/resolve/5f526678002e43af5551dadb73ce2e8c91b43afe';
const BFL_FP8 =
  'https://huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8/resolve/5b4408e59397a4a37ccb46afe426d8ed86379441';
const BFL_BASE_FP8 =
  'https://huggingface.co/black-forest-labs/FLUX.2-klein-base-4b-fp8/resolve/103db268c10d4d3921101b46057671f9ac460da6';

/** Diffusion model, fp8 (4.1 GB instead of 7.8 GB in bf16: fits an 8 GB card better). */
export const FLUX2_KLEIN_MODEL: ComfyModelFile = {
  folder: 'diffusion_models',
  file: 'flux-2-klein-4b-fp8.safetensors',
  url: `${BFL_FP8}/flux-2-klein-4b-fp8.safetensors`,
  sha256: '97ed34fe0567e436200f2faee3939b88f2b5d99f8af2a4dc16532c4245c0ccb6',
  sizeMb: 4071,
};

/**
 * The undistilled ("base") model, fp8: ~20 steps instead of 4 and a real
 * CFG, so it is slower but it USES a negative prompt (bad hands, extra
 * limbs, and the youth terms) and draws finer details. Same text encoder
 * and VAE as the distilled model.
 */
export const FLUX2_KLEIN_BASE_MODEL: ComfyModelFile = {
  folder: 'diffusion_models',
  file: 'flux-2-klein-base-4b-fp8.safetensors',
  url: `${BFL_BASE_FP8}/flux-2-klein-base-4b-fp8.safetensors`,
  sha256: '44bab3a86fe98b85d21dd2a4729ebdc3ae51fb8a39f76e457e18c724219e6840',
  sizeMb: 4089,
};

/** Text encoder (Qwen3 4B), the one of ComfyUI's official templates. */
export const FLUX2_KLEIN_TEXT_ENCODER: ComfyModelFile = {
  folder: 'text_encoders',
  file: 'qwen_3_4b.safetensors',
  url: `${KLEIN}/split_files/text_encoders/qwen_3_4b.safetensors`,
  sha256: '6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a',
  sizeMb: 8045,
};

export const FLUX2_VAE: ComfyModelFile = {
  folder: 'vae',
  file: 'flux2-vae.safetensors',
  url: `${KLEIN}/split_files/vae/flux2-vae.safetensors`,
  sha256: '868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3',
  sizeMb: 336,
};

/** Everything `setup:images -- --flux2-klein` installs. */
export const FLUX2_KLEIN_FILES: readonly ComfyModelFile[] = [FLUX2_KLEIN_MODEL, FLUX2_KLEIN_TEXT_ENCODER, FLUX2_VAE];
/** Everything `setup:images -- --flux2-klein-base` installs. */
export const FLUX2_KLEIN_BASE_FILES: readonly ComfyModelFile[] = [
  FLUX2_KLEIN_BASE_MODEL,
  FLUX2_KLEIN_TEXT_ENCODER,
  FLUX2_VAE,
];

/**
 * What the base model must avoid (it has a real negative prompt; the youth
 * terms are always added on top by buildNegativePrompt).
 */
export const FLUX2_NEGATIVE =
  'deformed hands, extra fingers, missing fingers, fused fingers, twisted fingers, extra arms, extra legs, ' +
  'disconnected limbs, malformed legs, bad anatomy, blurry, cgi, plastic skin, airbrushed';

/** One way of running FLUX.2 [klein], as a column of the test bench. */
export interface Flux2Variant {
  id: string;
  label: string;
  model: ComfyModelFile;
  steps: number;
  cfg: number;
  /** Real negative prompt (base model only: the distilled one ignores it at CFG 1). */
  negative: boolean;
  /** Her face as a reference picture (when the bench has one). */
  reference: boolean;
  /** A pose picture as second reference ("image 2"), when the shot has one (FLUX2_POSE_HINT). */
  pose: boolean;
}

/** Name used on the command line and the contact sheet. */
export const FLUX2_KLEIN_ID = 'flux2-klein-4b';

const DISTILLED = { model: FLUX2_KLEIN_MODEL, cfg: 1, negative: false } as const;

/**
 * The FLUX.2 columns of the test bench (ids for --models). Settings from
 * ComfyUI's official templates: distilled 4 steps CFG 1, base 20 steps CFG 5.
 */
export const FLUX2_VARIANTS: readonly Flux2Variant[] = [
  { id: FLUX2_KLEIN_ID, label: 'FLUX.2 [klein] 4B', ...DISTILLED, steps: 4, reference: true, pose: false },
  {
    id: 'flux2-klein-4b-8steps',
    label: 'FLUX.2 [klein] 4B, 8 steps',
    ...DISTILLED,
    steps: 8,
    reference: true,
    pose: false,
  },
  {
    id: 'flux2-klein-4b-8steps-pose',
    label: 'FLUX.2 [klein] 4B, 8 steps + pose guide',
    ...DISTILLED,
    steps: 8,
    reference: true,
    pose: true,
  },
  {
    id: 'flux2-klein-4b-noref',
    label: 'FLUX.2 [klein] 4B, without her face',
    ...DISTILLED,
    steps: 4,
    reference: false,
    pose: false,
  },
  {
    id: 'flux2-klein-4b-base',
    label: 'FLUX.2 [klein] 4B base (negative prompt)',
    model: FLUX2_KLEIN_BASE_MODEL,
    steps: 20,
    cfg: 5,
    negative: true,
    reference: true,
    pose: false,
  },
];

/**
 * Columns of the bench by default (when installed). History (2026-10-05):
 * 8 steps cleans details for ~1 s more than 4 with the same picture; the
 * base model was too saturated (CFG 5) and 5× slower; a 1.5× "refine" pass
 * only sharpened the same fingers; an "edit the hands" pass returned a copy
 * of the picture; a "correct hands" sentence changed nothing. All removed.
 * Words don't fix anatomy; a picture of a correct pose may (pose guide).
 */
export const FLUX2_DEFAULT_VARIANTS: readonly string[] = ['flux2-klein-4b-8steps', 'flux2-klein-4b-8steps-pose'];

/** A FLUX.2 variant by id. */
export function flux2Variant(id: string): Flux2Variant | undefined {
  return FLUX2_VARIANTS.find((v) => v.id === id);
}

/** Sampler of every FLUX.2 variant (official templates). */
export const FLUX2_SAMPLER = 'euler';

/**
 * What the app uses (bench of 2026-10-05: the distilled model at 8 steps,
 * her face as reference, no other pass).
 */
export const FLUX2_APP_SETTINGS = { steps: 8, cfg: 1, sampler: FLUX2_SAMPLER } as const;

/**
 * Look of FLUX.2 photos. Not the SDXL style (IMAGE_STYLE): FLUX.2 takes words
 * literally, and "smartphone photo" made her hold a phone in most pictures
 * (mirror selfies nobody asked for, a phone AND a book on the sofa → tangled
 * hands and feet). Bench results of 2026-10-05.
 */
export const FLUX2_PHOTO_STYLE =
  'Natural light, realistic skin texture with pores, natural body proportions, sharp focus, subtle film grain.';

/** Tells FLUX.2 to take only the face from the reference picture. */
export const FLUX2_REFERENCE_HINT =
  'Her face is exactly the face of the person in image 1; take only the face from image 1, not the clothes, hair style, pose, framing or background.';

/**
 * Tells FLUX.2 to copy only the pose from the pose guide ("image 2"): a
 * picture where body and hands are known to be right (chosen on the bench).
 */
export const FLUX2_POSE_HINT =
  'Her pose, body position and the way her hands hold things are exactly those of the person in image 2; take only ' +
  'the pose from image 2, not the face, hair, clothes or background.';

export interface Flux2PromptParts {
  style: ArtStyle;
  gender: Gender;
  /** The card's fixed look. */
  appearance: string;
  /** What this picture shows (LLM-written tags, or a bench shot). */
  scene: string;
  /** Is her face given as a reference picture? */
  reference: boolean;
  /** Is a pose guide given as "image 2" (after her face, "image 1")? */
  pose?: boolean | undefined;
}

/**
 * Sentences rather than a tag list: FLUX.2 reads its prompt with an LLM
 * (Qwen3), so the scene (framing, pose, place) must come first and clearly,
 * or it falls back to a centred, front-facing portrait. The subject is
 * always stated as an adult, here more than ever
 * because the distilled model has no negative prompt. "mature adult" is
 * not repeated as a separate tag: FLUX.2 made her look ten years older
 * than her card says. Pure function (exported for tests).
 */
export function buildFlux2Prompt(p: Flux2PromptParts): string {
  const who = p.gender === 'male' ? 'man' : 'woman';
  const subject = `an adult ${who}`;
  const medium = p.style === 'anime' ? 'An anime illustration' : 'A candid photo';
  const parts = [
    `${medium} of ${subject}. Scene: ${p.scene.trim()}.`,
    `She looks like this: ${p.appearance.trim()}.`.replace(/^She/, p.gender === 'male' ? 'He' : 'She'),
    p.reference ? FLUX2_REFERENCE_HINT.replace(/^Her/, p.gender === 'male' ? 'His' : 'Her') : '',
    p.style === 'anime' ? '' : FLUX2_PHOTO_STYLE,
    p.pose ? FLUX2_POSE_HINT.replace(/^Her/, p.gender === 'male' ? 'His' : 'Her') : '',
  ];
  return parts.filter(Boolean).join(' ').replace(/\.\.+/g, '.');
}

/**
 * Square crop of the reference picture around the face (×1.3 its size: face
 * and some hair, little clothing or background),
 * kept inside the picture. Giving FLUX.2 the whole portrait made it copy
 * the portrait: same grey top, same window, same front-facing framing.
 * Pure function (exported for tests).
 */
export function referenceCrop(face: FaceBox, width: number, height: number): CropBox {
  const side = Math.max(16, Math.floor(Math.min(Math.max(face.width, face.height) * 1.3, width, height)));
  const cx = face.x + face.width / 2;
  const cy = face.y + face.height / 2;
  return {
    x: Math.round(Math.min(Math.max(0, cx - side / 2), width - side)),
    y: Math.round(Math.min(Math.max(0, cy - side / 2), height - side)),
    width: side,
    height: side,
  };
}

export interface Flux2WorkflowParams {
  positive: string;
  seed: number;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  /** Her reference face, uploaded to ComfyUI's input folder (LoadImage name). */
  referenceImage?: string | undefined;
  /** Part of the reference picture to use (her face); whole picture when undefined. */
  referenceCrop?: CropBox | undefined;
  /** Model files (defaults: the pinned ones above). */
  files?: { model: string; textEncoder: string; vae: string };
  /**
   * Negative prompt, for the base model (CFG > 1). Undefined = zeroed
   * conditioning, as the distilled model expects.
   */
  negative?: string | undefined;
  /**
   * Pose guide uploaded to ComfyUI (LoadImage name): a second reference,
   * after her face. Needs referenceImage (the prompt numbers them 1 and 2).
   */
  poseImage?: string | undefined;
}

/** FLUX.2 latents are 16 px per cell: sizes must be multiples of 16. */
export const multipleOf16 = (v: number): number => Math.max(16, Math.round(v / 16) * 16);

/**
 * Node ids: 1 model · 2 text encoder · 3 VAE · 4 prompt · 5 negative (empty or text) ·
 * 6 latent · 7 save · 8 scheduler · 9 sampler · 10 noise · 11 guider ·
 * 12 sample · 13 decode · 20–25 reference face (optional, 25 = crop) ·
 * 50–54 pose guide (optional, second reference).
 */
export function buildFlux2Workflow(p: Flux2WorkflowParams): ComfyWorkflow {
  const files = p.files ?? {
    model: FLUX2_KLEIN_MODEL.file,
    textEncoder: FLUX2_KLEIN_TEXT_ENCODER.file,
    vae: FLUX2_VAE.file,
  };
  const width = multipleOf16(p.width);
  const height = multipleOf16(p.height);
  const workflow: ComfyWorkflow = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: files.model, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: files.textEncoder, type: 'flux2', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: files.vae } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: p.positive, clip: ['2', 0] } },
    '5':
      p.negative === undefined
        ? { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } }
        : { class_type: 'CLIPTextEncode', inputs: { text: p.negative, clip: ['2', 0] } },
    '6': { class_type: 'EmptyFlux2LatentImage', inputs: { width, height, batch_size: 1 } },
    '8': { class_type: 'Flux2Scheduler', inputs: { steps: p.steps, width, height } },
    '9': { class_type: 'KSamplerSelect', inputs: { sampler_name: p.sampler } },
    '10': { class_type: 'RandomNoise', inputs: { noise_seed: p.seed } },
    '11': {
      class_type: 'CFGGuider',
      inputs: { model: ['1', 0], positive: ['4', 0], negative: ['5', 0], cfg: p.cfg },
    },
    '12': {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: ['10', 0], guider: ['11', 0], sampler: ['9', 0], sigmas: ['8', 0], latent_image: ['6', 0] },
    },
    '13': { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['3', 0] } },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'girllm_flux2', images: ['13', 0] } },
  };

  if (p.referenceImage) {
    // Her face as a reference picture (FLUX.2's built-in multi-reference),
    // encoded once and attached to both conditionings, as in the official
    // edit templates. Scaled to ~1 megapixel first.
    workflow['20'] = { class_type: 'LoadImage', inputs: { image: p.referenceImage } };
    let source: [string, number] = ['20', 0];
    if (p.referenceCrop) {
      const c = p.referenceCrop;
      workflow['25'] = {
        class_type: 'ImageCrop',
        inputs: { image: ['20', 0], width: c.width, height: c.height, x: c.x, y: c.y },
      };
      source = ['25', 0];
    }
    workflow['21'] = {
      class_type: 'ImageScaleToTotalPixels',
      inputs: { image: source, upscale_method: 'lanczos', megapixels: 1, resolution_steps: 1 },
    };
    workflow['22'] = { class_type: 'VAEEncode', inputs: { pixels: ['21', 0], vae: ['3', 0] } };
    workflow['23'] = { class_type: 'ReferenceLatent', inputs: { conditioning: ['4', 0], latent: ['22', 0] } };
    workflow['24'] = { class_type: 'ReferenceLatent', inputs: { conditioning: ['5', 0], latent: ['22', 0] } };
    workflow['11']!.inputs.positive = ['23', 0];
    workflow['11']!.inputs.negative = ['24', 0];
  }

  if (p.poseImage && p.referenceImage) {
    // Second reference, chained after her face (so it is "image 2"), ~1 MP.
    workflow['50'] = { class_type: 'LoadImage', inputs: { image: p.poseImage } };
    workflow['51'] = {
      class_type: 'ImageScaleToTotalPixels',
      inputs: { image: ['50', 0], upscale_method: 'lanczos', megapixels: 1, resolution_steps: 1 },
    };
    workflow['52'] = { class_type: 'VAEEncode', inputs: { pixels: ['51', 0], vae: ['3', 0] } };
    workflow['53'] = { class_type: 'ReferenceLatent', inputs: { conditioning: ['23', 0], latent: ['52', 0] } };
    workflow['54'] = { class_type: 'ReferenceLatent', inputs: { conditioning: ['24', 0], latent: ['52', 0] } };
    workflow['11']!.inputs.positive = ['53', 0];
    workflow['11']!.inputs.negative = ['54', 0];
  }
  return workflow;
}
