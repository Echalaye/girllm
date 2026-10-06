/**
 * Face detail pass (step 6), the ComfyUI equivalent of "ADetailer", built
 * from CORE nodes only (no custom node pack, no Python dependency):
 *
 *   generated picture ──► crop around the face ──► upscale to 1024 px
 *     ──► re-sample at low denoise (same model, same prompt + face words,
 *         and her IP-Adapter face when available)
 *     ──► scale back ──► paste with a feathered mask ──► save
 *
 * Why: in a waist-up or full-body shot the face is only ~150 px wide, too
 * few pixels for SDXL to draw eyes properly. Redrawing it at 1024 px fixes
 * the asymmetric / blurry eyes. Close-up portraits are left alone.
 */
import type { FaceBox } from './faceDetector.js';
import type { FaceParams } from './ipAdapter.js';
import { addFaceAdapter, type ComfyWorkflow } from './workflow.js';

/** Faces taller than this share of the picture are already detailed enough. */
export const MAX_FACE_SHARE = 0.4;
/** Context kept around the face, as a multiple of its size. */
const CONTEXT = 2.2;
/** Size the face crop is redrawn at. */
const REDRAW_SIZE = 1024;
/** Words appended to the prompt for the redraw. */
export const FACE_DETAIL_TAGS = 'detailed face, detailed eyes, symmetrical eyes, sharp focus';

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const multipleOf8 = (v: number) => Math.max(8, Math.floor(v / 8) * 8);

/**
 * Square crop centred on the face with some context, kept inside the
 * picture, or undefined when the face is big enough already (close-up).
 * Pure function (exported for tests).
 */
export function planFaceCrop(face: FaceBox, width: number, height: number): CropBox | undefined {
  if (face.height > height * MAX_FACE_SHARE) return undefined;
  const side = multipleOf8(Math.min(Math.max(face.width, face.height) * CONTEXT, width, height));
  const cx = face.x + face.width / 2;
  const cy = face.y + face.height / 2;
  const x = Math.round(Math.min(Math.max(0, cx - side / 2), width - side));
  const y = Math.round(Math.min(Math.max(0, cy - side / 2), height - side));
  return { x, y, width: side, height: side };
}

export interface DetailWorkflowParams {
  checkpoint: string;
  /** The generated picture, uploaded to ComfyUI's input folder. */
  image: string;
  crop: CropBox;
  positive: string;
  negative: string;
  seed: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  /** How much the face may change (0.3–0.45 is typical). */
  denoise: number;
  /** Her reference face (IP-Adapter), to make the redraw look like her. */
  face?: FaceParams | undefined;
}

/**
 * Node ids: 1 checkpoint · 3/4 prompts · 12–15 IP-Adapter (optional) ·
 * 20 load · 21 crop · 22 upscale · 23 encode · 24 sample · 25 decode ·
 * 26 scale back · 27/28 feathered mask · 29 composite · 7 save
 */
export function buildFaceDetailWorkflow(p: DetailWorkflowParams): ComfyWorkflow {
  const { crop } = p;
  const feather = Math.round(crop.width * 0.12);
  const workflow: ComfyWorkflow = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: p.checkpoint } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: `${p.positive}, ${FACE_DETAIL_TAGS}`, clip: ['1', 1] } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: p.negative, clip: ['1', 1] } },
    '20': { class_type: 'LoadImage', inputs: { image: p.image } },
    '21': {
      class_type: 'ImageCrop',
      inputs: { image: ['20', 0], width: crop.width, height: crop.height, x: crop.x, y: crop.y },
    },
    '22': {
      class_type: 'ImageScale',
      inputs: {
        image: ['21', 0],
        upscale_method: 'lanczos',
        width: REDRAW_SIZE,
        height: REDRAW_SIZE,
        crop: 'disabled',
      },
    },
    '23': { class_type: 'VAEEncode', inputs: { pixels: ['22', 0], vae: ['1', 2] } },
    '24': {
      class_type: 'KSampler',
      inputs: {
        seed: p.seed,
        steps: p.steps,
        cfg: p.cfg,
        sampler_name: p.sampler,
        scheduler: p.scheduler,
        denoise: p.denoise,
        model: p.face ? ['15', 0] : ['1', 0],
        positive: ['3', 0],
        negative: ['4', 0],
        latent_image: ['23', 0],
      },
    },
    '25': { class_type: 'VAEDecode', inputs: { samples: ['24', 0], vae: ['1', 2] } },
    '26': {
      class_type: 'ImageScale',
      inputs: { image: ['25', 0], upscale_method: 'lanczos', width: crop.width, height: crop.height, crop: 'disabled' },
    },
    // A soft-edged mask so the redrawn square blends into the picture.
    '27': { class_type: 'SolidMask', inputs: { value: 1, width: crop.width, height: crop.height } },
    '28': {
      class_type: 'FeatherMask',
      inputs: { mask: ['27', 0], left: feather, top: feather, right: feather, bottom: feather },
    },
    '29': {
      class_type: 'ImageCompositeMasked',
      inputs: {
        destination: ['20', 0],
        source: ['26', 0],
        x: crop.x,
        y: crop.y,
        resize_source: false,
        mask: ['28', 0],
      },
    },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'girllm_detail', images: ['29', 0] } },
  };
  if (p.face && p.face.weight > 0) addFaceAdapter(workflow, p.face);
  else workflow['24']!.inputs.model = ['1', 0];
  return workflow;
}
