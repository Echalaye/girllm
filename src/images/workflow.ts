/**
 * Builds SDXL text-to-image workflows in ComfyUI's API format.
 *
 * Optional second "hires" pass (IMAGE_HIRES_SCALE > 1): the first image is
 * upscaled in pixel space (Lanczos) then re-sampled with a low denoise.
 * This adds real detail — sharper eyes, skin and hair — which is where
 * SDXL portraits at base resolution look soft. Pixel-space upscaling keeps
 * the composition better than latent upscaling at low denoise.
 *
 * Optional face reference (step 4d): IP-Adapter Plus Face patches the model
 * with her reference portrait, so both sampling passes keep her face.
 */
import { CLIP_VISION_MODEL, FACE_IPADAPTER_MODEL, type FaceParams } from './ipAdapter.js';

export type ComfyWorkflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

export interface HiresParams {
  /** Upscale factor, e.g. 1.25. */
  scale: number;
  /** How much the second pass may change the image (0.25–0.45 is typical). */
  denoise: number;
  steps: number;
}

export interface WorkflowParams {
  checkpoint: string;
  positive: string;
  negative: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed: number;
  /** Second refinement pass; omitted or scale <= 1 = single pass. */
  hires?: HiresParams | undefined;
  /** Reference face (IP-Adapter); omitted = text prompt only. */
  face?: FaceParams | undefined;
}

/**
 * Node ids are numeric strings, like workflows exported from ComfyUI:
 *   1 checkpoint · 2 empty latent · 3/4 positive/negative prompts · 5 sampler · 6 VAE decode · 7 save
 *   hires pass: 8 upscale (pixels) · 9 VAE encode · 10 sampler (low denoise) · 11 VAE decode
 *   face: 12 load image · 13 IP-Adapter model · 14 CLIP vision · 15 IP-Adapter (patched model)
 */
export function buildTxt2ImgWorkflow(p: WorkflowParams): ComfyWorkflow {
  const face = p.face && p.face.weight > 0 ? p.face : undefined;
  // Every sampler uses the face-patched model when there is a reference face.
  const model: [string, number] = face ? ['15', 0] : ['1', 0];
  const sampler = (latent: [string, number], steps: number, denoise: number) => ({
    class_type: 'KSampler',
    inputs: {
      seed: p.seed,
      steps,
      cfg: p.cfg,
      sampler_name: p.sampler,
      scheduler: p.scheduler,
      denoise,
      model,
      positive: ['3', 0],
      negative: ['4', 0],
      latent_image: latent,
    },
  });

  const workflow: ComfyWorkflow = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: p.checkpoint } },
    '2': { class_type: 'EmptyLatentImage', inputs: { width: p.width, height: p.height, batch_size: 1 } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: p.positive, clip: ['1', 1] } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: p.negative, clip: ['1', 1] } },
    '5': sampler(['2', 0], p.steps, 1),
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
  };

  if (face) {
    workflow['12'] = { class_type: 'LoadImage', inputs: { image: face.image } };
    workflow['13'] = { class_type: 'IPAdapterModelLoader', inputs: { ipadapter_file: FACE_IPADAPTER_MODEL.file } };
    workflow['14'] = { class_type: 'CLIPVisionLoader', inputs: { clip_name: CLIP_VISION_MODEL.file } };
    workflow['15'] = {
      class_type: 'IPAdapterAdvanced',
      inputs: {
        model: ['1', 0],
        ipadapter: ['13', 0],
        image: ['12', 0],
        clip_vision: ['14', 0],
        weight: face.weight,
        weight_type: 'linear',
        combine_embeds: 'concat',
        start_at: 0,
        end_at: 1,
        embeds_scaling: 'V only',
      },
    };
  }

  let finalImage: [string, number] = ['6', 0];
  if (p.hires && p.hires.scale > 1) {
    workflow['8'] = {
      class_type: 'ImageScaleBy',
      inputs: { image: ['6', 0], upscale_method: 'lanczos', scale_by: p.hires.scale },
    };
    workflow['9'] = { class_type: 'VAEEncode', inputs: { pixels: ['8', 0], vae: ['1', 2] } };
    workflow['10'] = sampler(['9', 0], p.hires.steps, p.hires.denoise);
    workflow['11'] = { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['1', 2] } };
    finalImage = ['11', 0];
  }

  workflow['7'] = { class_type: 'SaveImage', inputs: { filename_prefix: 'girllm', images: finalImage } };
  return workflow;
}
